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
import { extractFromPage } from "@/lib/extract";
import { parseModelChoice, resolveModel } from "@/lib/models";
import { MAX_PANEL_REQUESTS, MAX_REQUEST_CHARS, type PanelData } from "@/lib/panel-file";

// Identifies a browser for rate limiting only; panels are stored in the browser.
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

// The panel as the browser holds it: validated here because server actions take untrusted input.
function parsePanel(value: unknown): PanelData {
  const v = value as Partial<PanelData> | null;
  if (typeof v?.html !== "string") throw new Error("Missing panel.");
  if (v.html.length > MAX_HTML_CHARS) throw new Error("The page is too large.");
  const requests = Array.isArray(v.requests)
    ? v.requests.filter((r): r is string => typeof r === "string").map((r) => r.slice(0, MAX_REQUEST_CHARS))
    : [];
  return { html: v.html, requests: requests.slice(-MAX_PANEL_REQUESTS) };
}
export type { RequestOrigin };

export type LoginState = { error: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const attempt = String(formData.get("password") ?? "");
  if (!checkPassword(attempt)) {
    if (!process.env.APP_PASSWORD) console.error("APP_PASSWORD is not set; sign-in is disabled.");
    return { error: "Wrong password." };
  }
  await setAuthCookie();
  // Back to the panel that asked for the sign-in, if any.
  const next = String(formData.get("next") ?? "");
  redirect(/^\/p\/[A-Z0-9]{8}$/.test(next) ? next : "/");
}

// Runs the model on the panel the browser sends and returns the new page and history.
// Nothing is stored here: the browser saves the result as the panel's next version.
export async function submitRequest(
  transcript: string,
  origin: RequestOrigin,
  modelChoice: unknown,
  panel: unknown,
): Promise<UIResult & { requests?: string[] }> {
  if (!(await isAuthenticated())) {
    return { html: "", message: "", error: "Not signed in. Reload the page." };
  }
  let doc: PanelData;
  try {
    doc = parsePanel(panel);
  } catch (err) {
    return { html: "", message: "", error: (err as Error).message };
  }
  const text = transcript.trim().slice(0, 4000);
  if (!text) return { html: doc.html, message: "" };

  try {
    // The user's own key (if any) is used for this call only; it is never stored or logged.
    const { model, providerOptions } = resolveModel(parseModelChoice(modelChoice));
    const result = await generateText({
      model,
      system: SYSTEM,
      prompt: buildPrompt(doc, text, origin),
      tools: buildTools(doc),
      stopWhen: isStepCount(8),
      maxOutputTokens: 32000,
      providerOptions,
    });
    const requests = [...doc.requests, historyEntry(text, origin)].slice(-MAX_PANEL_REQUESTS);
    return { html: doc.html, message: result.text, requests };
  } catch (err) {
    console.error("submitRequest failed:", err instanceof Error ? err.message : err);
    return { html: "", message: "", error: err instanceof Error ? err.message : "Something went wrong." };
  }
}

export type ExtractResult = { data?: unknown; url?: string; fetchedAt?: string; cached?: boolean; error?: string };

const EXTRACT_LIMIT = 30;
const EXTRACT_WINDOW_MS = 10 * 60_000;
const extractCalls = new Map<string, number[]>();

// Called by generated pages through fetchData(url, instruction): the server reads the page
// and an LLM turns it into JSON; the page renders it.
export async function extractData(url: unknown, instruction: unknown, modelChoice?: unknown): Promise<ExtractResult> {
  if (!(await isAuthenticated())) return { error: "Not signed in. Reload the page." };
  if (typeof url !== "string" || typeof instruction !== "string" || !instruction.trim()) {
    return { error: "fetchData needs a URL and an instruction." };
  }
  if (url.length > 2000 || instruction.length > 2000) return { error: "URL or instruction too long." };

  const id = await sessionId();
  const now = Date.now();
  const recent = (extractCalls.get(id) ?? []).filter((t) => now - t < EXTRACT_WINDOW_MS);
  if (recent.length >= EXTRACT_LIMIT) return { error: "Too many data requests; try again in a few minutes." };
  recent.push(now);
  extractCalls.set(id, recent);

  try {
    return await extractFromPage(url, instruction.trim(), parseModelChoice(modelChoice));
  } catch (err) {
    console.error("extractData failed:", err instanceof Error ? err.message : err);
    return { error: err instanceof Error ? err.message : "Couldn't read that page." };
  }
}
