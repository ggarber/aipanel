// Panels live only in this browser's localStorage, one key per code. Each save bumps the
// version; views only take a stored copy that is newer than what they show.

import { INITIAL_HTML } from "./initial-html";
import { generateCode, isPanelCode } from "./panel-code";
import { MAX_PANEL_REQUESTS } from "./panel-file";

export type StoredPanel = {
  code: string;
  version: number;
  html: string;
  requests: string[];
  createdAt: string;
  updatedAt: string;
};

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
    return typeof p.html === "string" && typeof p.version === "number" ? { ...p, requests: p.requests ?? [] } : null;
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

function write(panel: StoredPanel) {
  try {
    localStorage.setItem(PREFIX + panel.code, JSON.stringify(panel));
  } catch {
    throw new Error("This browser's storage is full. Delete or export some panels.");
  }
  listeners.forEach((l) => l());
}

// Saves new content as the next version, after whatever is stored (another tab may
// have saved in the meantime).
export function savePanel(code: string, data: { html: string; requests: string[] }): StoredPanel {
  const current = getPanel(code);
  const now = new Date().toISOString();
  const panel: StoredPanel = {
    code,
    version: (current?.version ?? 0) + 1,
    html: data.html,
    requests: data.requests.slice(-MAX_PANEL_REQUESTS),
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  write(panel);
  return panel;
}

export function createPanel(): StoredPanel {
  let code = generateCode();
  while (getPanel(code)) code = generateCode();
  return savePanel(code, { html: INITIAL_HTML, requests: [] });
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
