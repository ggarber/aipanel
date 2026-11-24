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
//   server_llm  whether the server may run the model for this panel with its own key
//               (default from SERVER_LLM_DEFAULT; switch per panel with an UPDATE)
// Without DATABASE_URL (local dev before the database exists) an in-memory store with the
// same behaviour is used instead.

// Keeps rows small (a few pages of HTML); old versions are dropped to fit.
const MAX_RECORD_BYTES = 900_000;

// New panels may use the server's model only when the operator says so.
export function serverLlmDefault(): boolean {
  return process.env.SERVER_LLM_DEFAULT === "true";
}

interface Store {
  getId(code: string): Promise<string | null>;
  claimCode(code: string, id: string, serverLlm: boolean): Promise<boolean>;
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
      )`
      .then(() => sql`ALTER TABLE panels ADD COLUMN IF NOT EXISTS server_llm boolean NOT NULL DEFAULT false`)
      .catch((err) => {
        ready = null;
        throw err;
      }));
  return {
    async getId(code) {
      await schema();
      const rows = await sql`SELECT id FROM panels WHERE code = ${code}`;
      return (rows[0]?.id as string | undefined) ?? null;
    },
    async claimCode(code, id, serverLlm) {
      await schema();
      // version 0 and an empty record until the first compareAndSet fills it in.
      const rows = await sql`
        INSERT INTO panels (id, code, version, record, server_llm) VALUES (${id}, ${code}, 0, '{}'::jsonb, ${serverLlm})
        ON CONFLICT (code) DO NOTHING RETURNING id`;
      return rows.length === 1;
    },
    async getRecord(id) {
      await schema();
      const rows = await sql`SELECT record, server_llm FROM panels WHERE id = ${id} AND version > 0`;
      const row = rows[0];
      return row ? { ...(row.record as PanelRecord), serverLlm: row.server_llm === true } : null;
    },
    async compareAndSet(id, expected, record) {
      await schema();
      // The flag lives in its own column; it isn't copied into the record.
      const data = { ...record } as Partial<PanelRecord>;
      delete data.serverLlm;
      const rows = await sql`
        UPDATE panels SET record = ${JSON.stringify(data)}::jsonb, version = ${record.version}, updated_at = now()
        WHERE id = ${id} AND version = ${expected} RETURNING id`;
      return rows.length === 1;
    },
  };
}

function memoryStore(): Store {
  const g = globalThis as unknown as {
    panelsMemory?: { codes: Map<string, string>; records: Map<string, PanelRecord>; flags: Map<string, boolean> };
  };
  const db = (g.panelsMemory ??= { codes: new Map(), records: new Map(), flags: new Map() });
  return {
    getId: async (code) => db.codes.get(code) ?? null,
    async claimCode(code, id, serverLlm) {
      if (db.codes.has(code)) return false;
      db.codes.set(code, id);
      db.flags.set(id, serverLlm);
      return true;
    },
    async getRecord(id) {
      const record = db.records.get(id);
      return record ? { ...structuredClone(record), serverLlm: db.flags.get(id) === true } : null;
    },
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

// Stores a new panel as version 1; null when the code was taken in the meantime.
async function createPanel(
  code: string,
  change: { html: string; requests: string[] },
  note: string,
): Promise<PanelRecord | null> {
  const id = randomUUID();
  const serverLlm = serverLlmDefault();
  if (!(await db().claimCode(code, id, serverLlm))) return null;
  const now = new Date().toISOString();
  const record = fit({
    id,
    code,
    version: 1,
    html: change.html,
    requests: change.requests,
    note: note.slice(0, 200),
    createdAt: now,
    updatedAt: now,
    history: [],
    serverLlm,
  });
  await db().compareAndSet(id, 0, record);
  return record;
}

// Saves new content as the next version, moving the current one into history; the first
// save of a code creates the panel. Retries when another save got in first, so concurrent
// saves each get their own version.
export async function savePanel(
  code: string,
  change: { html: string; requests: string[] },
  note: string,
): Promise<PanelRecord> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await findPanel(code);
    if (!current) {
      const created = await createPanel(code, change, note);
      if (created) return created;
      continue; // someone else created it just now: save on top of theirs
    }
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
