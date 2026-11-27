import "server-only";

import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { MAX_HISTORY, type PanelContent, type PanelRecord, type PanelVersion } from "./panel-types";

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
  // Saved state for the panel's page (panel_state): key, JSON value, date of the last save.
  getState(panelId: string, key: string): Promise<StateEntry | null>;
  // Returns null when the panel already has MAX_STATE_KEYS keys and this one is new.
  setState(panelId: string, key: string, value: unknown): Promise<StateEntry | null>;
  listState(panelId: string, prefix: string): Promise<{ key: string; date: string }[]>;
  deleteState(panelId: string, key: string): Promise<boolean>;
}

export type StateEntry = { key: string; value: unknown; date: string };
export const MAX_STATE_KEYS = 500;

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
      .then(
        () => sql`
          CREATE TABLE IF NOT EXISTS panel_state (
            panel_id uuid NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
            key text NOT NULL,
            value jsonb NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (panel_id, key)
          )`,
      )
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
    async getState(panelId, key) {
      await schema();
      const rows = await sql`SELECT key, value, updated_at FROM panel_state WHERE panel_id = ${panelId} AND key = ${key}`;
      return rows[0] ? entry(rows[0]) : null;
    },
    async setState(panelId, key, value) {
      await schema();
      // Inserts a new key only while the panel is under MAX_STATE_KEYS; updates always.
      const rows = await sql`
        INSERT INTO panel_state (panel_id, key, value)
        SELECT ${panelId}, ${key}, ${JSON.stringify(value)}::jsonb
        WHERE EXISTS (SELECT 1 FROM panel_state WHERE panel_id = ${panelId} AND key = ${key})
           OR (SELECT count(*) FROM panel_state WHERE panel_id = ${panelId}) < ${MAX_STATE_KEYS}
        ON CONFLICT (panel_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        RETURNING key, value, updated_at`;
      return rows[0] ? entry(rows[0]) : null;
    },
    async listState(panelId, prefix) {
      await schema();
      const rows = await sql`
        SELECT key, updated_at FROM panel_state
        WHERE panel_id = ${panelId} AND left(key, ${prefix.length}) = ${prefix}
        ORDER BY key LIMIT ${MAX_STATE_KEYS}`;
      return rows.map((r) => ({ key: r.key as string, date: new Date(r.updated_at as string).toISOString() }));
    },
    async deleteState(panelId, key) {
      await schema();
      const rows = await sql`DELETE FROM panel_state WHERE panel_id = ${panelId} AND key = ${key} RETURNING key`;
      return rows.length === 1;
    },
  };
}

function entry(row: Record<string, unknown>): StateEntry {
  return { key: row.key as string, value: row.value, date: new Date(row.updated_at as string).toISOString() };
}

function memoryStore(): Store {
  const g = globalThis as unknown as {
    panelsMemory?: { codes: Map<string, string>; records: Map<string, PanelRecord>; flags: Map<string, boolean> };
  };
  const db = (g.panelsMemory ??= { codes: new Map(), records: new Map(), flags: new Map() });
  const gs = globalThis as unknown as { panelsMemoryState?: Map<string, Map<string, { value: unknown; date: string }>> };
  const states = (gs.panelsMemoryState ??= new Map());
  const stateOf = (panelId: string) => {
    let m = states.get(panelId);
    if (!m) states.set(panelId, (m = new Map()));
    return m;
  };
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
    async getState(panelId, key) {
      const e = stateOf(panelId).get(key);
      return e ? { key, value: structuredClone(e.value), date: e.date } : null;
    },
    async setState(panelId, key, value) {
      const m = stateOf(panelId);
      if (!m.has(key) && m.size >= MAX_STATE_KEYS) return null;
      const e = { value: structuredClone(value), date: new Date().toISOString() };
      m.set(key, e);
      return { key, value, date: e.date };
    },
    async listState(panelId, prefix) {
      return [...stateOf(panelId).entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, e]) => ({ key, date: e.date }))
        .sort((a, b) => a.key.localeCompare(b.key));
    },
    async deleteState(panelId, key) {
      return stateOf(panelId).delete(key);
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

// The stored fields of a change: Classic content gets no agent/parts keys at all, so Classic
// records stay exactly as they were.
function content(change: PanelContent): PanelContent {
  return {
    html: change.html,
    requests: change.requests,
    ...(change.agent === "structured" && change.parts && { agent: "structured" as const, parts: change.parts }),
  };
}

// Stores a new panel as version 1; null when the code was taken in the meantime.
async function createPanel(
  code: string,
  change: PanelContent,
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
    ...content(change),
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
  change: PanelContent,
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
      ...content(current),
      note: current.note,
      savedAt: current.updatedAt,
    };
    // The new content decides the agent: a Classic save drops the parts.
    const base: PanelRecord = { ...current };
    delete base.agent;
    delete base.parts;
    const next = fit({
      ...base,
      version: current.version + 1,
      ...content(change),
      note: note.slice(0, 200),
      updatedAt: new Date().toISOString(),
      history: [previous, ...current.history].slice(0, MAX_HISTORY),
    });
    if (await db().compareAndSet(current.id, current.version, next)) return next;
  }
  throw new Error("The panel is changing too fast; try again.");
}

// Saved state of a panel's page, by code. The panel must exist (its page has been saved).
async function panelIdOf(code: string): Promise<string> {
  const id = await db().getId(code);
  if (!id || !(await db().getRecord(id))) throw new Error(`Panel ${code} isn't saved yet.`);
  return id;
}

export async function getPanelState(code: string, key: string) {
  return db().getState(await panelIdOf(code), key);
}

export async function setPanelState(code: string, key: string, value: unknown) {
  const saved = await db().setState(await panelIdOf(code), key, value);
  if (!saved) throw new Error(`This panel already has ${MAX_STATE_KEYS} saved keys. Delete some first.`);
  return saved;
}

export async function listPanelState(code: string, prefix: string) {
  return db().listState(await panelIdOf(code), prefix);
}

export async function deletePanelState(code: string, key: string) {
  return db().deleteState(await panelIdOf(code), key);
}
