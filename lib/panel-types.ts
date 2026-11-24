// Shared by the server (database) and the browser (cache).

export const MAX_HISTORY = 5;

// A saved state of the page. note says what made it ("a todo list", "Reset", "Imported"…).
export type PanelVersion = {
  version: number;
  html: string;
  requests: string[];
  note: string;
  savedAt: string;
};

export type PanelRecord = {
  id: string; // generated, never changes
  code: string; // chosen by the user: 8 characters, A-Z and 0-9
  version: number;
  html: string;
  requests: string[];
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
