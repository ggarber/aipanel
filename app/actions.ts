"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { generateText, isStepCount } from "ai";
import { checkPassword, isAuthenticated, setAuthCookie } from "@/lib/auth";
import {
  buildPrompt,
  buildTools,
  historyEntry,
  MAX_HTML_CHARS,
  SYSTEM,
  type RequestOrigin,
} from "@/lib/genui";
import { parseModelChoice, resolveModel } from "@/lib/models";
import { getSession, INITIAL_HTML, recordRequest, resetSession } from "@/lib/ui-store";

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

export type UIResult = { html: string; message: string; error?: string };
export type { RequestOrigin };

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
  modelChoice?: unknown,
): Promise<UIResult> {
  if (!(await isAuthenticated())) {
    return { html: "", message: "", error: "Not signed in. Reload the page." };
  }
  const text = transcript.trim().slice(0, 4000);
  const session = getSession(await sessionId());
  if (!text) return { html: session.html, message: "" };

  try {
    // The user's own key (if any) is used for this call only; it is never stored or logged.
    const { model, providerOptions } = resolveModel(parseModelChoice(modelChoice));
    const result = await generateText({
      model,
      system: SYSTEM,
      prompt: buildPrompt(session, text, origin),
      tools: buildTools(session),
      stopWhen: isStepCount(8),
      maxOutputTokens: 32000,
      providerOptions,
    });
    recordRequest(session, historyEntry(text, origin));
    return { html: session.html, message: result.text };
  } catch (err) {
    console.error("submitRequest failed:", err instanceof Error ? err.message : err);
    return {
      html: session.html,
      message: "",
      error: err instanceof Error ? err.message : "Something went wrong.",
    };
  }
}

// Local (in-browser) model: the page runs the model itself. It reads the session first
// and saves the result after, so history and Reset work the same as with remote models.
export async function getLocalContext(): Promise<{ html: string; requests: string[]; fresh: boolean }> {
  if (!(await isAuthenticated())) throw new Error("Not signed in. Reload the page.");
  const session = getSession(await sessionId());
  return { html: session.html, requests: [...session.requests], fresh: session.html === INITIAL_HTML };
}

export async function saveLocalResult(html: string, request: string): Promise<void> {
  if (!(await isAuthenticated())) throw new Error("Not signed in. Reload the page.");
  if (typeof html !== "string" || typeof request !== "string") throw new Error("Bad input.");
  if (html.length > MAX_HTML_CHARS) throw new Error("The page is too large.");
  const session = getSession(await sessionId());
  session.html = html;
  recordRequest(session, request.slice(0, 4000));
}

export async function resetUI(): Promise<string> {
  if (!(await isAuthenticated())) throw new Error("Not signed in.");
  const id = await sessionId();
  resetSession(id);
  return getSession(id).html;
}
