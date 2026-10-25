"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";
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

export async function getCurrentUI(): Promise<string> {
  return getSession(await sessionId()).html;
}

export async function submitRequest(transcript: string): Promise<UIResult> {
  const text = transcript.trim().slice(0, 4000);
  const session = getSession(await sessionId());
  if (!text) return { html: session.html, message: "" };

  const previous = session.requests.length
    ? `Earlier requests (oldest first):\n${session.requests.map((r) => `- ${r}`).join("\n")}\n\n`
    : "";

  try {
    const result = await generateText({
      model: anthropic("claude-opus-5-5"),
      system: SYSTEM,
      prompt: `${previous}Current HTML document:\n<current_html>\n${session.html}\n</current_html>\n\nUser request (speech transcript):\n<request>${text}</request>`,
      tools: buildTools(session),
      stopWhen: isStepCount(8),
      maxOutputTokens: 32000,
      providerOptions: {
        anthropic: {
          effort: "medium",
          // Retry on another model server-side if a safety classifier declines the request.
          fallbacks: "default",
        },
      },
    });
    recordRequest(session, text);
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
  const id = await sessionId();
  resetSession(id);
  return getSession(id).html;
}
