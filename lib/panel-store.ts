// Panels live only in this browser's localStorage, one key per code. Each save bumps the
// version; views only take a stored copy that is newer than what they show.

import { INITIAL_HTML } from "./initial-html";
import { generateCode, isPanelCode } from "./panel-code";
import { MAX_PANEL_REQUESTS } from "./panel-file";

// A saved state of the page. note says what made it ("a todo list", "Reset", "Imported"…).
export type PanelVersion = {
  version: number;
  html: string;
  requests: string[];
  note: string;
  savedAt: string;
};

export type StoredPanel = {
  code: string;
  version: number;
  html: string;
  requests: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
  // The previous versions, newest first, at most MAX_HISTORY.
  history: PanelVersion[];
};

export const MAX_HISTORY = 5;

// A short name for a page: its <title>, else its first <h1>.
export function panelTitle(html: string): string {
  const match = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(html) ?? /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(html);
  const text = match?.[1].replace(/<[^>]+>/g, "").trim();
  return text || "Untitled panel";
}

const PREFIX = "aipanel:panel:";
const listeners = new Set<() => void>();
const snapshots = new Map<string, { raw: string | null; panel: StoredPanel | null }>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parse(raw: string | null): StoredPanel | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as StoredPanel;
    if (typeof p.html !== "string" || typeof p.version !== "number") return null;
    return { ...p, requests: p.requests ?? [], note: p.note ?? "", history: Array.isArray(p.history) ? p.history : [] };
  } catch {
    return null;
  }
}

// Stable object per stored string, as useSyncExternalStore needs.
export function getPanel(code: string): StoredPanel | null {
  const raw = read(PREFIX + code);
  const cached = snapshots.get(code);
  if (cached && cached.raw === raw) return cached.panel;
  const panel = parse(raw);
  snapshots.set(code, { raw, panel });
  return panel;
}

export function listPanels(): StoredPanel[] {
  const panels: StoredPanel[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const panel = getPanel(key.slice(PREFIX.length));
      if (panel) panels.push(panel);
    }
  } catch {}
  return panels.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// When storage is full, drops the oldest saved versions before giving up.
function write(panel: StoredPanel) {
  for (let keep = panel.history.length; ; keep--) {
    try {
      localStorage.setItem(PREFIX + panel.code, JSON.stringify({ ...panel, history: panel.history.slice(0, keep) }));
      break;
    } catch {
      if (keep === 0) throw new Error("This browser's storage is full. Delete or export some panels.");
    }
  }
  listeners.forEach((l) => l());
}

// Saves new content as the next version, after whatever is stored (another tab may
// have saved in the meantime).
export function savePanel(code: string, data: { html: string; requests: string[] }, note: string): StoredPanel {
  const current = getPanel(code);
  const now = new Date().toISOString();
  const previous: PanelVersion[] = current
    ? [
        { version: current.version, html: current.html, requests: current.requests, note: current.note, savedAt: current.updatedAt },
        ...current.history,
      ].slice(0, MAX_HISTORY)
    : [];
  const panel: StoredPanel = {
    code,
    version: (current?.version ?? 0) + 1,
    html: data.html,
    requests: data.requests.slice(-MAX_PANEL_REQUESTS),
    note: note.slice(0, 200),
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    history: previous,
  };
  write(panel);
  return panel;
}

export function createPanel(): StoredPanel {
  let code = generateCode();
  while (getPanel(code)) code = generateCode();
  return savePanel(code, { html: INITIAL_HTML, requests: [] }, "Created");
}

// Brings back an older page as a new version, so the page being replaced stays in history.
export function revertPanel(code: string, version: number): StoredPanel {
  const target = getPanel(code)?.history.find((v) => v.version === version);
  if (!target) throw new Error(`Version ${version} is no longer saved.`);
  return savePanel(code, { html: target.html, requests: target.requests }, `Reverted to v${version}`);
}

export function deletePanel(code: string) {
  try {
    localStorage.removeItem(PREFIX + code);
  } catch {}
  listeners.forEach((l) => l());
}

export function subscribePanels(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => (e.key === null || e.key.startsWith(PREFIX)) && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export { isPanelCode };
