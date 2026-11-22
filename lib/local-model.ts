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
- Use plain JavaScript for interactions (toggles, counters, filters, adding items).
- For a button that needs new content, call askLLM("short instruction", {state}) on click;
  it is already defined in the page.
- When editing, keep everything in the current document that the request doesn't change.`;

// Pulls the document out of the reply, which may be wrapped in a markdown fence.
export function extractHtml(reply: string): string | null {
  const start = reply.search(/<!doctype html|<html[\s>]/i);
  const end = reply.toLowerCase().lastIndexOf("</html>");
  if (start === -1 || end === -1 || end < start) return null;
  return reply.slice(start, end + "</html>".length);
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
