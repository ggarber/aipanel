import { tool } from "ai";
import { z } from "zod";

// Shared by the server action (remote models) and the browser (local model), so both
// paths use the same prompt and the same document-editing tools.

export const SYSTEM = `You are the engine of a voice-driven generative UI. The user speaks a request; the
transcript is sent to you along with the HTML document currently on screen.

Your job is to change the screen to satisfy the request, using the tools:
- edit_html: targeted find/replace on the current document. Prefer it for small changes
  (recolor, rename, add an item, tweak layout) — it is faster and keeps everything else intact.
- set_html: replace the whole document. Use it for a new screen or a substantial redesign.

You work as an agent: you can call tools several times before answering. Research tools (when
they are available):
- web_search(query): searches the web and returns a short answer with source URLs. Use it when
  the request needs facts you're not sure of or recent information (news, prices, schedules,
  people, events). Search first, then build the page.
- fetch_url(url): returns the text of a web page. Use it to read a page the user names or a
  source from web_search.
Put what you learn into the HTML (with the source and the date you looked it up). For data that
must keep refreshing while the page is open, use fetchData in the page instead (see below).

Rules for the HTML:
- A complete, self-contained document (<!doctype html> … </html>). Inline all CSS and JS.
- It renders in a sandboxed iframe that fills the viewport. Scripts run; there is no network
  access to your server, no cookies, no localStorage guarantee, and no parent-page access.
- External resources only from https://cdn.jsdelivr.net or https://unpkg.com if truly needed.
- Make it look polished and modern, responsive, and readable. Keep the bottom-right corner
  (about 96x96px) free of important content — a floating edit button sits there.
- Transcripts come from speech recognition and may have errors; infer the intent.

Interactivity — pick the cheapest mechanism that works:
- Plain embedded JavaScript for anything computable in the page: counters, toggles, tabs,
  filters, sorting, form validation, timers, small calculations. No round trip to you.
- askLLM(request, context) is a global function already defined in the page. Calling it sends
  the request back to you as a new turn, and you update this document again. Use it only when
  the action needs knowledge, generation, or a new/changed screen, e.g. a "More about the
  weather in Paris" button, "Generate 5 more ideas", "Show details for this item".
  - request: a short plain-language instruction, written as if the user had said it.
  - context: an optional JSON-serializable object with the state the request depends on
    (form values, the selected item, the current counter value…).
  - Runtime changes made by scripts are NOT kept: each update starts from the HTML you wrote.
    Pass any runtime state you need to preserve in context, and bake it into the new HTML.
  - Only call askLLM from a user action (click, submit) — never on load, in timers, or in loops.
  - Disable the triggering control and show a loading state when calling it; the whole page is
    replaced when the response arrives.
Live data from the web — fetchData(url, instruction) is also a global function in the page.
It returns a Promise of { data, url, fetchedAt }: the server downloads the page at url, and an
LLM extracts what the instruction asks for and returns it as JSON in data. It rejects with an
Error on failure.
  - Use it when the user names a site or asks for live information (prices, rates, schedules,
    scores). Spell out the exact JSON shape in the instruction, e.g. 'Return {"unit": string,
    "hours": [{"hour": "00-01", "price": number}]} with the price for every hour of today'.
  - Unlike askLLM it may run on load, and periodically with setInterval — at most every
    5 minutes (results are cached for 5 minutes anyway). Default to every 15 minutes.
  - Render data with plain JS: inline SVG charts or HTML tables (or Chart.js from
    https://cdn.jsdelivr.net if a real chart library is needed). Show a loading state, the
    error message on failure (keep the last good data), the source and "updated hh:mm".
  - Never put data you didn't get from fetchData in the page as if it were live.
- Without web_search, fetch_url or fetchData you have no live data. For real-time topics you
  couldn't look up, give general or typical information and label it as not live.

Always call a tool to change the screen unless the request is unclear or impossible; then make
no tool call and reply with one short sentence. After your tool calls, reply with one short
sentence describing what changed.`;

// The research tools' implementations differ between the server and the browser.
export type AgentIO = {
  search?: (query: string) => Promise<{ answer: string; sources: { title?: string; url: string }[] }>;
  fetch?: (url: string) => Promise<{ url: string; text: string }>;
  // Called when a research tool starts, for the status line.
  onTool?: (name: "web_search" | "fetch_url", input: string) => void;
};

export const MAX_AGENT_STEPS = 12;
const MAX_FETCH_CHARS = 12_000;

function researchTools(io: AgentIO) {
  return {
    ...(io.search && {
      web_search: tool({
        description: "Search the web. Returns a short answer with the facts found and the source URLs.",
        inputSchema: z.object({ query: z.string().describe("What to search for.") }),
        execute: async ({ query }) => {
          io.onTool?.("web_search", query);
          try {
            return await io.search!(query);
          } catch (err) {
            return { error: err instanceof Error ? err.message : "Search failed." };
          }
        },
      }),
    }),
    ...(io.fetch && {
      fetch_url: tool({
        description: "Fetch a public web page and return its text (tables kept as rows).",
        inputSchema: z.object({ url: z.string().describe("The http(s) URL to read.") }),
        execute: async ({ url }) => {
          io.onTool?.("fetch_url", url);
          try {
            const page = await io.fetch!(url);
            return { url: page.url, text: page.text.slice(0, MAX_FETCH_CHARS) };
          } catch (err) {
            return { error: err instanceof Error ? err.message : "Couldn't read that page." };
          }
        },
      }),
    }),
  };
}

// Tools edit doc.html in place; io adds the research tools.
export function buildTools(doc: { html: string }, io: AgentIO = {}) {
  return {
    ...researchTools(io),
    set_html: tool({
      description: "Replace the entire HTML document shown to the user.",
      inputSchema: z.object({
        html: z.string().describe("The complete new HTML document."),
      }),
      execute: async ({ html }) => {
        doc.html = html;
        return { ok: true, length: html.length };
      },
    }),
    edit_html: tool({
      description:
        "Replace an exact substring of the current HTML document. old_string must appear exactly once. Call multiple times for multiple edits.",
      inputSchema: z.object({
        old_string: z.string().describe("Exact text currently in the document."),
        new_string: z.string().describe("Replacement text."),
      }),
      execute: async ({ old_string, new_string }) => applyEdit(doc, old_string, new_string),
    }),
  };
}

export function applyEdit(
  doc: { html: string },
  oldString: string,
  newString: string,
): { ok: true } | { ok: false; error: string } {
  const first = doc.html.indexOf(oldString);
  if (first === -1) return { ok: false, error: "old_string not found in the current document." };
  if (doc.html.indexOf(oldString, first + 1) !== -1) {
    return { ok: false, error: "old_string appears more than once; include more context." };
  }
  doc.html = doc.html.slice(0, first) + newString + doc.html.slice(first + oldString.length);
  return { ok: true };
}

// "voice": the user spoke (or typed) a request. "panel": the generated page called askLLM().
export type RequestOrigin = { source: "voice" } | { source: "panel"; context?: unknown };

export const MAX_HTML_CHARS = 500_000;
export const MAX_CONTEXT_CHARS = 8000;

export function buildPrompt(
  doc: { html: string; requests: string[] },
  text: string,
  origin: RequestOrigin,
): string {
  let contextJson = "";
  if (origin.source === "panel" && origin.context !== undefined) {
    try {
      contextJson = JSON.stringify(origin.context).slice(0, MAX_CONTEXT_CHARS);
    } catch {
      contextJson = "";
    }
  }
  const requestBlock =
    origin.source === "panel"
      ? `Request from the page via askLLM() (the user clicked something in the current UI):\n<request>${text}</request>` +
        (contextJson ? `\n<context>${contextJson}</context>` : "")
      : `User request (speech transcript):\n<request>${text}</request>`;
  const previous = doc.requests.length
    ? `Earlier requests (oldest first):\n${doc.requests.map((r) => `- ${r}`).join("\n")}\n\n`
    : "";
  return `${previous}Current HTML document:\n<current_html>\n${doc.html}\n</current_html>\n\n${requestBlock}`;
}

// How a request is stored in the session history.
export function historyEntry(text: string, origin: RequestOrigin): string {
  return origin.source === "panel" ? `[page] ${text}` : text;
}
