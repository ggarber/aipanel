// Chrome's built-in Prompt API (Gemini Nano, on device). Runs entirely in the browser.
// https://developer.chrome.com/docs/ai/prompt-api

import { MAX_CONTEXT_CHARS, type RequestOrigin } from "./genui";

type Availability = "unavailable" | "downloadable" | "downloading" | "available";
type LanguageOptions = {
  initialPrompts?: { role: "system" | "user" | "assistant"; content: string }[];
  expectedInputs?: { type: "text"; languages?: string[] }[];
  expectedOutputs?: { type: "text"; languages?: string[] }[];
  monitor?: (m: EventTarget) => void;
};
interface LanguageModelSession {
  prompt(input: string): Promise<string>;
  measureContextUsage?(input: string): Promise<number>;
  contextWindow?: number;
  destroy(): void;
}
interface LanguageModelStatic {
  availability(options?: LanguageOptions): Promise<Availability>;
  create(options?: LanguageOptions): Promise<LanguageModelSession>;
}

const IO: LanguageOptions = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

function api(): LanguageModelStatic | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { LanguageModel?: LanguageModelStatic }).LanguageModel ?? null;
}

export async function localAvailability(): Promise<Availability> {
  const lm = api();
  if (!lm) return "unavailable";
  try {
    return await lm.availability(IO);
  } catch {
    return "unavailable";
  }
}

// Gemini Nano has a small context window (about 9k tokens), no tool calling, and gets lost
// in the full system prompt and in JSON output. So it gets a short prompt of its own and
// answers with the whole new document as plain HTML.
const LOCAL_SYSTEM = `You build and edit web pages from a user's request. Reply with ONLY the complete
new HTML document (<!doctype html> … </html>): no markdown, no explanation.
- Self-contained: inline all CSS and JavaScript. No external resources.
- Polished, modern, responsive. Keep the bottom-right corner (96x96px) free; a button sits there.
- Put the visible content (text, items, numbers) directly in the HTML, not only in JavaScript.
- Put every <script> at the very end of <body>, after the elements it uses.
- Use plain JavaScript for interactions (toggles, counters, filters, adding items).
- "4x2 grid" means 4 columns and 2 rows.
- Only if a button must fetch new content: inside that button's click handler, call
  askLLM with a plain-language instruction (it is already defined in the page). Never call it
  when the page loads, in a timer or in a loop. Pick random items with Math.random instead.
- When editing, keep everything in the current document that the request doesn't change.
- To keep data the user adds (tasks, notes, scores) use the page's saveState(key, value) and
  await loadState(key) (returns {value} or null); not localStorage.
- Start the document with a short <!-- DESIGN NOTES ... --> comment (layout, colors, fonts,
  components). Follow the existing notes when editing and keep them updated.`;

// Pulls the document out of the reply, which may be wrapped in a markdown fence, and
// repairs what the small model often gets wrong (see repairHtml).
export function extractHtml(reply: string): string | null {
  const start = reply.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) return null;
  const end = reply.toLowerCase().lastIndexOf("</html>");
  // A reply cut off at the token limit: keep what's there and close the document.
  const html = end > start ? reply.slice(start, end + "</html>".length) : reply.slice(start).replace(/```\s*$/, "") + "\n</body></html>";
  return repairHtml(html);
}

// Gemini Nano often puts its <script> in <head> (or before the elements it uses), so it runs
// before the page exists: querySelector returns null and nothing gets filled in. Inline
// scripts move to the end of <body>, where everything they look for exists. Scripts with a
// src stay where they are, since inline code may depend on them.
export function repairHtml(html: string): string {
  const moved: string[] = [];
  const rest = html.replace(/<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi, (script) => {
    moved.push(script);
    return "";
  });
  if (!moved.length) return html;
  const close = rest.toLowerCase().lastIndexOf("</body>");
  const at = close === -1 ? rest.toLowerCase().lastIndexOf("</html>") : close;
  return at === -1 ? rest + moved.join("\n") : rest.slice(0, at) + moved.join("\n") + "\n" + rest.slice(at);
}

// fresh: the screen still shows the welcome page, which the small model would otherwise
// keep and decorate instead of replacing.
function buildLocalPrompt(
  doc: { html: string; requests: string[]; fresh: boolean },
  text: string,
  origin: RequestOrigin,
): string {
  let request = text;
  if (origin.source === "panel" && origin.context !== undefined) {
    try {
      request += `\nState from the page: ${JSON.stringify(origin.context).slice(0, MAX_CONTEXT_CHARS)}`;
    } catch {}
  }
  if (doc.fresh) return `Build a new page for this request: ${request}`;
  const history = doc.requests.length ? `\n\nEarlier requests:\n${doc.requests.map((r) => `- ${r}`).join("\n")}` : "";
  return `Current page:\n${doc.html}${history}\n\nRequest: ${request}\nReturn the full updated page.`;
}

export async function runLocalModel(
  doc: { html: string; requests: string[]; fresh: boolean },
  text: string,
  origin: RequestOrigin,
  onProgress?: (fraction: number) => void,
): Promise<{ html: string; message: string }> {
  const lm = api();
  if (!lm) throw new Error("This browser has no built-in model. Use a recent desktop Chrome, or pick another model in Settings.");
  const availability = await lm.availability(IO);
  if (availability === "unavailable") {
    throw new Error("Chrome's built-in model isn't available on this device. Pick another model in Settings.");
  }
  const session = await lm.create({
    ...IO,
    initialPrompts: [{ role: "system", content: LOCAL_SYSTEM }],
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => onProgress?.((e as ProgressEvent).loaded));
    },
  });
  try {
    const prompt = buildLocalPrompt(doc, text, origin);
    if (session.measureContextUsage && session.contextWindow) {
      const needed = await session.measureContextUsage(prompt);
      if (needed > session.contextWindow) {
        throw new Error("This page is too large for the built-in model. Reset, or pick another model in Settings.");
      }
    }
    const html = extractHtml(await session.prompt(prompt));
    if (!html) throw new Error("The built-in model didn't return a page. Try again.");
    return { html, message: "Updated the page with the built-in model." };
  } finally {
    session.destroy();
  }
}
