import "server-only";

export const INITIAL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: system-ui, sans-serif; background: #f8fafc; color: #334155; }
  .hint { text-align: center; max-width: 28rem; padding: 2rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; color: #0f172a; }
</style>
</head>
<body>
  <div class="hint">
    <h1>Say what you want to see</h1>
    <p>Press the talk button in the bottom right and describe a UI.
       Try “a todo list for a camping trip” or “a dashboard with three KPI cards”.</p>
  </div>
</body>
</html>`;

export type UISession = {
  // The last HTML the model produced. This is what the model edits next turn.
  html: string;
  // Recent user requests, oldest first, so follow-ups like "make it blue" have context.
  requests: string[];
};

const MAX_REQUESTS = 20;

// In-memory, per-process store. Fine for local dev and a single server instance;
// swap for Redis/KV/a database to survive restarts or run on serverless.
const globalForStore = globalThis as unknown as {
  uiSessions?: Map<string, UISession>;
};
const sessions = (globalForStore.uiSessions ??= new Map());

export function getSession(id: string): UISession {
  let session = sessions.get(id);
  if (!session) {
    session = { html: INITIAL_HTML, requests: [] };
    sessions.set(id, session);
  }
  return session;
}

export function recordRequest(session: UISession, text: string) {
  session.requests.push(text);
  if (session.requests.length > MAX_REQUESTS) session.requests.shift();
}

export function resetSession(id: string) {
  sessions.delete(id);
}
