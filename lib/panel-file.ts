// The panel export file: the session exactly as the server stores it (HTML + request
// history), wrapped with a format tag and version so imports can be checked.

export const PANEL_FORMAT = "aipanel";
export const PANEL_VERSION = 1;
export const MAX_PANEL_REQUESTS = 20;
export const MAX_REQUEST_CHARS = 4000;

export type PanelData = { html: string; requests: string[] };
export type PanelFile = PanelData & { format: typeof PANEL_FORMAT; version: number; exportedAt: string };

export function toPanelFile(data: PanelData): PanelFile {
  return { format: PANEL_FORMAT, version: PANEL_VERSION, exportedAt: new Date().toISOString(), ...data };
}

export function panelFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `aipanel-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}

// Accepts an export file, or a plain .html document (imported with no history).
export function parsePanelFile(text: string): PanelData {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    let v: Partial<PanelFile>;
    try {
      v = JSON.parse(trimmed);
    } catch {
      throw new Error("That file isn't valid JSON.");
    }
    if (v.format !== PANEL_FORMAT || typeof v.html !== "string") throw new Error("That isn't an aipanel export file.");
    if (typeof v.version !== "number" || v.version > PANEL_VERSION) {
      throw new Error("That export comes from a newer version of aipanel.");
    }
    return { html: v.html, requests: Array.isArray(v.requests) ? v.requests : [] };
  }
  if (/^<(!doctype html|html[\s>])/i.test(trimmed)) return { html: text, requests: [] };
  throw new Error("Import an aipanel .json export or an .html file.");
}
