import "server-only";

import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { MAX_HISTORY, type PanelRecord, type PanelVersion } from "./panel-types";

// Panels in Postgres (Neon), one row per panel:
//   id       uuid, generated, primary key
//   code     8 characters chosen by the user, unique
//   version  bumped by every save with a conditional UPDATE, so concurrent saves can't
//            both win the same version
//   record   jsonb PanelRecord: the current page and the last MAX_HISTORY versions
// Without DATABASE_URL (local dev before the database exists) an in-memory store with the
// same behaviour is used instead.

// Keeps rows small (a few pages of HTML); old versions are dropped to fit.
const MAX_RECORD_BYTES = 900_000;

interface Store {
  getId(code: string): Promise<string | null>;
  claimCode(code: string, id: string): Promise<boolean>;
  getRecord(id: string): Promise<PanelRecord | null>;
  // Writes the record only if the stored version is still `expected`; returns whether it did.
  compareAndSet(id: string, expected: number, record: PanelRecord): Promise<boolean>;
}

function postgresStore(url: string): Store {
  const sql = neon(url);
  let ready: Promise<unknown> | null = null;
  // Creates the table on first use, once per server instance.
  const schema = () =>
    (ready ??= sql`
      CREATE TABLE IF NOT EXISTS panels (
        id uuid PRIMARY KEY,
        code text NOT NULL UNIQUE,
        version integer NOT NULL,
        record jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`.catch((err) => {
      ready = null;
      throw err;
    }));
  return {
    async getId(code) {
      await schema();
      const rows = await sql`SELECT id FROM panels WHERE code = ${code}`;
      return (rows[0]?.id as string | undefined) ?? null;
    },
    async claimCode(code, id) {
      await schema();
      // version 0 and an empty record until the first compareAndSet fills it in.
      const rows = await sql`
        INSERT INTO panels (id, code, version, record) VALUES (${id}, ${code}, 0, '{}'::jsonb)
        ON CONFLICT (code) DO NOTHING RETURNING id`;
      return rows.length === 1;
    },
    async getRecord(id) {
      await schema();
      const rows = await sql`SELECT record FROM panels WHERE id = ${id} AND version > 0`;
      return (rows[0]?.record as PanelRecord | undefined) ?? null;
    },
    async compareAndSet(id, expected, record) {
      await schema();
      const rows = await sql`
        UPDATE panels SET record = ${JSON.stringify(record)}::jsonb, version = ${record.version}, updated_at = now()
        WHERE id = ${id} AND version = ${expected} RETURNING id`;
      return rows.length === 1;
    },
  };
}

function memoryStore(): Store {
  const g = globalThis as unknown as { panelsMemory?: { codes: Map<string, string>; records: Map<string, PanelRecord> } };
  const db = (g.panelsMemory ??= { codes: new Map(), records: new Map() });
  return {
    getId: async (code) => db.codes.get(code) ?? null,
    async claimCode(code, id) {
      if (db.codes.has(code)) return false;
      db.codes.set(code, id);
      return true;
    },
    getRecord: async (id) => structuredClone(db.records.get(id) ?? null),
    async compareAndSet(id, expected, record) {
      if ((db.records.get(id)?.version ?? 0) !== expected) return false;
      db.records.set(id, structuredClone(record));
      return true;
    },
  };
}

let store: Store | null = null;
function db(): Store {
  if (!store) {
    const url = process.env.DATABASE_URL;
    if (url) store = postgresStore(url);
    else {
      console.warn("No DATABASE_URL: panels are kept in memory and lost on restart.");
      store = memoryStore();
    }
  }
  return store;
}

export async function findPanel(code: string): Promise<PanelRecord | null> {
  const id = await db().getId(code);
  return id ? db().getRecord(id) : null;
}

function fit(record: PanelRecord): PanelRecord {
  const r = { ...record, history: [...record.history] };
  while (r.history.length && JSON.stringify(r).length > MAX_RECORD_BYTES) r.history.pop();
  if (JSON.stringify(r).length > MAX_RECORD_BYTES) throw new Error("The page is too large to save.");
  return r;
}

export async function createPanel(code: string, html: string, note: string): Promise<PanelRecord | null> {
  const id = randomUUID();
  if (!(await db().claimCode(code, id))) return null;
  const now = new Date().toISOString();
  const record = fit({ id, code, version: 1, html, requests: [], note, createdAt: now, updatedAt: now, history: [] });
  await db().compareAndSet(id, 0, record);
  return record;
}

// Saves new content as the next version, moving the current one into history. Retries
// when another save got in first, so concurrent saves each get their own version.
export async function savePanel(
  code: string,
  change: { html: string; requests: string[] },
  note: string,
): Promise<PanelRecord> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await findPanel(code);
    if (!current) throw new Error(`Panel ${code} doesn't exist.`);
    const previous: PanelVersion = {
      version: current.version,
      html: current.html,
      requests: current.requests,
      note: current.note,
      savedAt: current.updatedAt,
    };
    const next = fit({
      ...current,
      version: current.version + 1,
      html: change.html,
      requests: change.requests,
      note: note.slice(0, 200),
      updatedAt: new Date().toISOString(),
      history: [previous, ...current.history].slice(0, MAX_HISTORY),
    });
    if (await db().compareAndSet(current.id, current.version, next)) return next;
  }
  throw new Error("The panel is changing too fast; try again.");
}
