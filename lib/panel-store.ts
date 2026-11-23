// Browser cache of panels from the server, one localStorage key per code. A cached copy is
// only replaced by a newer version, and views render from here, so a panel shows at once
// and then updates when the server has something newer.

import type { PanelRecord } from "./panel-types";

export type { PanelRecord as StoredPanel } from "./panel-types";
export { panelTitle } from "./panel-types";

const PREFIX = "aipanel:panel:";
const listeners = new Set<() => void>();
const snapshots = new Map<string, { raw: string | null; panel: PanelRecord | null }>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parse(raw: string | null): PanelRecord | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PanelRecord;
    if (typeof p.html !== "string" || typeof p.version !== "number") return null;
    return { ...p, requests: p.requests ?? [], note: p.note ?? "", history: Array.isArray(p.history) ? p.history : [] };
  } catch {
    return null;
  }
}

// Stable object per stored string, as useSyncExternalStore needs.
export function getPanel(code: string): PanelRecord | null {
  const raw = read(PREFIX + code);
  const cached = snapshots.get(code);
  if (cached && cached.raw === raw) return cached.panel;
  const panel = parse(raw);
  snapshots.set(code, { raw, panel });
  return panel;
}

export function listPanels(): PanelRecord[] {
  const panels: PanelRecord[] = [];
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

function notify() {
  listeners.forEach((l) => l());
}

// Stores a server copy unless the cache already has this version or a newer one. Returns
// whether it was stored. If storage is full, older versions are dropped from the cached copy.
export function cachePanel(panel: PanelRecord): boolean {
  const current = getPanel(panel.code);
  if (current && current.id === panel.id && current.version >= panel.version) return false;
  for (let keep = panel.history.length; keep >= 0; keep--) {
    try {
      localStorage.setItem(PREFIX + panel.code, JSON.stringify({ ...panel, history: panel.history.slice(0, keep) }));
      notify();
      return true;
    } catch {}
  }
  return false;
}

// Removes the cached copy only; the panel stays on the server.
export function forgetPanel(code: string) {
  try {
    localStorage.removeItem(PREFIX + code);
  } catch {}
  notify();
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
