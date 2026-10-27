"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { google } from "@ai-sdk/google";
import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";
import { checkPassword, isAuthenticated, setAuthCookie } from "@/lib/auth";
import {
  getSession,
  recordRequest,
  resetSession,
  type UISession,
} from "@/lib/ui-store";

const SESSION_COOKIE = "genui_session";

async function sessionId(): Promise<string> {
  const store = await cookies();
  let id = store.get(SESSION_COOKIE)?.value;
  if (!id) {
    id = randomUUID();
    store.set(SESSION_COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/" });
  }
  return id;
}

const SYSTEM = `You are the engine of a voice-driven generative UI. The user speaks a request; the
transcript is sent to you along with the HTML document currently on screen.

Your job is to change the screen to satisfy the request, using the tools:
- edit_html: targeted find/replace on the current document. Prefer it for small changes
  (recolor, rename, add an item, tweak layout) — it is faster and keeps everything else intact.
- set_html: replace the whole document. Use it for a new screen or a substantial redesign.

Rules for the HTML:
- A complete, self-contained document (<!doctype html> … </html>). Inline all CSS and JS.
- It renders in a sandboxed iframe that fills the viewport. Scripts run; there is no network
  access to your server, no cookies, no localStorage guarantee, and no parent-page access.
- External resources only from https://cdn.jsdelivr.net or https://unpkg.com if truly needed.
- Make it look polished and modern, responsive, and readable. Keep the bottom-right corner
  (about 96x96px) free of important content — a floating talk button sits there.
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
- You have no internet access or live data. For real-time topics (weather, prices, news), give
  general or typical information and label it as not live.

Always call a tool to change the screen unless the request is unclear or impossible; then make
no tool call and reply with one short sentence. After your tool calls, reply with one short
sentence describing what changed.`;

function buildTools(session: UISession) {
  return {
    set_html: tool({
      description: "Replace the entire HTML document shown to the user.",
      inputSchema: z.object({
        html: z.string().describe("The complete new HTML document."),
      }),
      execute: async ({ html }) => {
        session.html = html;
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
      execute: async ({ old_string, new_string }) => {
        const first = session.html.indexOf(old_string);
        if (first === -1) {
          return { ok: false, error: "old_string not found in the current document." };
        }
        if (session.html.indexOf(old_string, first + 1) !== -1) {
          return { ok: false, error: "old_string appears more than once; include more context." };
        }
        session.html =
          session.html.slice(0, first) + new_string + session.html.slice(first + old_string.length);
        return { ok: true };
      },
    }),
  };
}

export type UIResult = { html: string; message: string; error?: string };

// "voice": the user spoke (or typed) a request. "panel": the generated page called askLLM().
export type RequestOrigin = { source: "voice" } | { source: "panel"; context?: unknown };

const MAX_CONTEXT_CHARS = 8000;

export type LoginState = { error: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const attempt = String(formData.get("password") ?? "");
  if (!checkPassword(attempt)) {
    if (!process.env.APP_PASSWORD) console.error("APP_PASSWORD is not set; sign-in is disabled.");
    return { error: "Wrong password." };
  }
  await setAuthCookie();
  redirect("/");
}

export async function submitRequest(
  transcript: string,
  origin: RequestOrigin = { source: "voice" },
): Promise<UIResult> {
  if (!(await isAuthenticated())) {
    return { html: "", message: "", error: "Not signed in. Reload the page." };
  }
  const text = transcript.trim().slice(0, 4000);
  const session = getSession(await sessionId());
  if (!text) return { html: session.html, message: "" };

  const fromPanel = origin.source === "panel";
  let contextJson = "";
  if (fromPanel && origin.context !== undefined) {
    try {
      contextJson = JSON.stringify(origin.context).slice(0, MAX_CONTEXT_CHARS);
    } catch {
      contextJson = "";
    }
  }
  const requestBlock = fromPanel
    ? `Request from the page via askLLM() (the user clicked something in the current UI):\n<request>${text}</request>` +
      (contextJson ? `\n<context>${contextJson}</context>` : "")
    : `User request (speech transcript):\n<request>${text}</request>`;

  const previous = session.requests.length
    ? `Earlier requests (oldest first):\n${session.requests.map((r) => `- ${r}`).join("\n")}\n\n`
    : "";

  try {
    const result = await generateText({
      // Calls the Gemini API directly; reads GOOGLE_GENERATIVE_AI_API_KEY.
      model: google("gemini-3.8-flash"),
      system: SYSTEM,
      prompt: `${previous}Current HTML document:\n<current_html>\n${session.html}\n</current_html>\n\n${requestBlock}`,
      tools: buildTools(session),
      stopWhen: isStepCount(8),
      maxOutputTokens: 32000,
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: "medium" } },
      },
    });
    recordRequest(session, fromPanel ? `[page] ${text}` : text);
    return { html: session.html, message: result.text };
  } catch (err) {
    console.error("submitRequest failed", err);
    return {
      html: session.html,
      message: "",
      error: err instanceof Error ? err.message : "Something went wrong.",
    };
  }
}

export async function resetUI(): Promise<string> {
  if (!(await isAuthenticated())) throw new Error("Not signed in.");
  const id = await sessionId();
  resetSession(id);
  return getSession(id).html;
}
