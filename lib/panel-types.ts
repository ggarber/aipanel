// Shared by the server (database) and the browser (cache).

import type { PageParts, PanelAgent } from "./structured";

// Which agent edits a page, and its parts when that's the Structured one. html is always the
// page shown (for Structured pages, the parts rendered), so everything that only shows pages
// works for both. Classic pages have neither field: records saved before the Structured agent
// existed are Classic.
export type PanelContent = {
  html: string;
  requests: string[];
  agent?: Exclude<PanelAgent, "classic">;
  parts?: PageParts;
};

export function agentOf(content: { agent?: string } | null | undefined): PanelAgent {
  return content?.agent === "structured" ? "structured" : "classic";
}

export const MAX_HISTORY = 5;

// A saved state of the page. note says what made it ("a todo list", "Reset", "Imported"…).
export type PanelVersion = PanelContent & {
  version: number;
  note: string;
  savedAt: string;
};

export type PanelRecord = PanelContent & {
  id: string; // generated, never changes
  code: string; // chosen by the user: 8 characters, A-Z and 0-9
  version: number;
  note: string;
  createdAt: string;
  updatedAt: string;
  history: PanelVersion[]; // previous versions, newest first, at most MAX_HISTORY
  // Whether the server may run the model for this panel with its own key. Kept in its own
  // database column (server_llm) so an operator can switch it per panel.
  serverLlm: boolean;
};

// A short name for a page: its <title>, else its first <h1>.
export function panelTitle(html: string): string {
  const match = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(html) ?? /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(html);
  const text = match?.[1].replace(/<[^>]+>/g, "").trim();
  return text || "Untitled panel";
}
