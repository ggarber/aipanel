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
import { INITIAL_HTML } from "@/lib/initial-html";
import { isPanelCode } from "@/lib/panel-code";
import { MAX_PANEL_REQUESTS, MAX_REQUEST_CHARS, type PanelData } from "@/lib/panel-file";
import type { PanelRecord } from "@/lib/panel-types";
import * as panels from "@/lib/panels-db";

// Identifies a browser for rate limiting only.
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

export type PanelResult = { panel?: PanelRecord; message?: string; error?: string };

async function guard(code: unknown): Promise<string> {
  if (!(await isAuthenticated())) throw new Error("Not signed in. Reload the page.");
  if (typeof code !== "string" || !isPanelCode(code)) throw new Error("Panel codes are 8 letters or numbers.");
  return code;
}

function failure(err: unknown): PanelResult {
  return { error: err instanceof Error ? err.message : "Something went wrong." };
}

// knownVersion: the version the browser has cached; the panel is only sent back when the
// server's is newer.
export async function openPanel(
  code: unknown,
  knownVersion?: number,
): Promise<{ status: "found"; panel: PanelRecord } | { status: "current" } | { status: "missing" } | { error: string }> {
  try {
    const panel = await panels.findPanel(await guard(code));
    if (!panel) return { status: "missing" };
    if (typeof knownVersion === "number" && panel.version <= knownVersion) return { status: "current" };
    return { status: "found", panel };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// Claims a code for a new panel. content uploads a page that so far only exists in this
// browser (panels made before the database existed).
export async function createPanel(code: unknown, content?: unknown): Promise<PanelResult> {
  try {
    const c = await guard(code);
    const doc = content === undefined ? { html: INITIAL_HTML, requests: [] } : parsePanel(content);
    const panel = await panels.createPanel(c, doc.html, content === undefined ? "Created" : "Uploaded from this browser");
    if (!panel) return { error: `The code ${c} is already taken.` };
    if (doc.requests.length) return { panel: await panels.savePanel(c, doc, "Uploaded from this browser") };
    return { panel };
  } catch (err) {
    return failure(err);
  }
}

// Saves a page made in the browser (local model, Import, Reset) as the next version.
export async function savePanelContent(code: unknown, content: unknown, note: unknown): Promise<PanelResult> {
  try {
    const c = await guard(code);
    return { panel: await panels.savePanel(c, parsePanel(content), typeof note === "string" ? note : "") };
  } catch (err) {
    return failure(err);
  }
}

// Brings back an older version as a new version, so the replaced page stays in history.
export async function revertPanel(code: unknown, version: unknown): Promise<PanelResult> {
  try {
    const c = await guard(code);
    const target = (await panels.findPanel(c))?.history.find((v) => v.version === version);
    if (!target) return { error: `Version ${version} is no longer saved.` };
    return { panel: await panels.savePanel(c, target, `Reverted to v${target.version}`) };
  } catch (err) {
    return failure(err);
  }
}

// Runs the model on the stored panel and saves the result as the next version.
export async function submitRequest(
  transcript: string,
  origin: RequestOrigin,
  modelChoice: unknown,
  code: unknown,
): Promise<PanelResult> {
  let c: string;
  try {
    c = await guard(code);
  } catch (err) {
    return failure(err);
  }
  const text = typeof transcript === "string" ? transcript.trim().slice(0, 4000) : "";
  const current = await panels.findPanel(c);
  if (!current) return { error: `Panel ${c} doesn't exist.` };
  if (!text) return { panel: current };

  try {
    const doc = { html: current.html, requests: current.requests };
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
    const entry = historyEntry(text, origin);
    const requests = [...doc.requests, entry].slice(-MAX_PANEL_REQUESTS);
    // No change to the page (the model only answered): no new version.
    if (doc.html === current.html) {
      return { panel: current, message: result.text };
    }
    return { panel: await panels.savePanel(c, { html: doc.html, requests }, entry), message: result.text };
  } catch (err) {
    console.error("submitRequest failed:", err instanceof Error ? err.message : err);
    return failure(err);
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
