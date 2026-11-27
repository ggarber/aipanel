"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { generateText, isStepCount } from "ai";
import { extractWithServer, pageText } from "@/lib/extract";
import {
  buildPrompt,
  buildTools,
  historyEntry,
  MAX_AGENT_STEPS,
  MAX_HTML_CHARS,
  SYSTEM,
  type RequestOrigin,
} from "@/lib/genui";
import { serverModel } from "@/lib/models";
import {
  buildStructuredPrompt,
  buildStructuredTools,
  INITIAL_PARTS,
  partsFromHtml,
  STRUCTURED_SYSTEM,
  structuredContent,
  type PanelAgent,
} from "@/lib/structured";
import { SERVER_MODEL } from "@/lib/model-settings";
import { webSearch } from "@/lib/web-search";
import { isPanelCode } from "@/lib/panel-code";
import { MAX_PANEL_REQUESTS, MAX_REQUEST_CHARS, type PanelData } from "@/lib/panel-file";
import { agentOf, type PanelRecord } from "@/lib/panel-types";
import * as panels from "@/lib/panels-db";

export type { RequestOrigin };

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

// A page made in the browser: validated here because server actions take untrusted input.
function parsePanel(value: unknown): PanelData {
  const v = value as Partial<PanelData> | null;
  if (typeof v?.html !== "string") throw new Error("Missing panel.");
  if (v.html.length > MAX_HTML_CHARS) throw new Error("The page is too large.");
  const requests = Array.isArray(v.requests)
    ? v.requests.filter((r): r is string => typeof r === "string").map((r) => r.slice(0, MAX_REQUEST_CHARS))
    : [];
  // A Structured page: its HTML is rendered here from the parts, never taken from the browser.
  if (v.agent === "structured") {
    const { parts, html } = structuredContent(v.parts);
    if (html.length > MAX_HTML_CHARS) throw new Error("The page is too large.");
    return { html, requests: requests.slice(-MAX_PANEL_REQUESTS), agent: "structured", parts };
  }
  return { html: v.html, requests: requests.slice(-MAX_PANEL_REQUESTS) };
}

export type PanelResult = { panel?: PanelRecord; message?: string; error?: string };

// There is no sign-in: knowing a panel's code is what gives access to it.
async function guard(code: unknown): Promise<string> {
  if (typeof code !== "string" || !isPanelCode(code)) throw new Error("Panel codes are 8 letters or numbers.");
  return code;
}

function failure(err: unknown): PanelResult {
  return { error: err instanceof Error ? err.message : "Something went wrong." };
}

const NO_SERVER_LLM =
  "This panel can't use the server's model. Pick your own key or the in-browser model in Settings.";

// Whether the server may run the model for this panel: its flag, or for a panel that
// doesn't exist yet, the default new panels will get.
async function serverLlmAllowed(code: string): Promise<boolean> {
  const panel = await panels.findPanel(code);
  return panel ? panel.serverLlm : panels.serverLlmDefault();
}

export type OpenResult =
  | { status: "found"; panel: PanelRecord }
  | { status: "current"; serverLlm: boolean }
  | { status: "missing"; serverLlm: boolean }
  | { error: string };

// Checks a code. knownVersion is the version the browser has cached: the panel is only
// sent back when the server's is newer. A missing panel is created by its first change.
export async function openPanel(code: unknown, knownVersion?: number): Promise<OpenResult> {
  try {
    const panel = await panels.findPanel(await guard(code));
    if (!panel) return { status: "missing", serverLlm: panels.serverLlmDefault() };
    if (typeof knownVersion === "number" && panel.version <= knownVersion) {
      return { status: "current", serverLlm: panel.serverLlm };
    }
    return { status: "found", panel };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// Stores a page made in the browser (local model, the user's own key, Import, Reset) as the
// next version; the first change of a new code creates the panel.
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

// Switches the agent that edits a saved panel, converting the page once and saving it as a
// new version (so Versions can undo it). Structured → Classic keeps the rendered HTML;
// Classic → Structured wraps the HTML into the three parts.
export async function setPanelAgent(code: unknown, agent: unknown): Promise<PanelResult> {
  try {
    const c = await guard(code);
    if (agent !== "classic" && agent !== "structured") return { error: "Unknown agent." };
    const current = await panels.findPanel(c);
    if (!current) return { error: "This panel isn't saved yet." };
    if (agentOf(current) === agent) return { panel: current };
    if (agent === "classic") {
      return { panel: await panels.savePanel(c, { html: current.html, requests: current.requests }, "Switched to the Classic agent") };
    }
    const { parts, html } = structuredContent(partsFromHtml(current.html));
    return {
      panel: await panels.savePanel(
        c,
        { html, requests: current.requests, agent: "structured", parts },
        "Switched to the Structured agent",
      ),
    };
  } catch (err) {
    return failure(err);
  }
}

// The server runs its own model on the stored panel (or the starting page, for a new code)
// and stores the result. Only for panels whose server_llm flag allows it. A stored panel
// keeps its agent; a new code uses startAgent.
export async function submitRequest(
  transcript: string,
  origin: RequestOrigin,
  code: unknown,
  startHtml?: unknown,
  startAgent?: unknown,
): Promise<PanelResult> {
  let c: string;
  try {
    c = await guard(code);
  } catch (err) {
    return failure(err);
  }
  const text = typeof transcript === "string" ? transcript.trim().slice(0, 4000) : "";
  const current = await panels.findPanel(c);
  if (!(current ? current.serverLlm : panels.serverLlmDefault())) return { error: NO_SERVER_LLM };
  if (!text) return current ? { panel: current } : {};

  const agent: PanelAgent = current ? agentOf(current) : startAgent === "structured" ? "structured" : "classic";
  if (agent === "structured") return submitStructured(c, text, origin, current);

  try {
    const start = current ?? parsePanel({ html: startHtml, requests: [] });
    const doc = { html: start.html, requests: start.requests };
    const { model, providerOptions } = serverModel();
    const result = await generateText({
      model,
      system: SYSTEM,
      prompt: buildPrompt(doc, text, origin),
      // Research tools run here too: search with the server's Gemini, pages through the
      // address-checked fetcher (cached for 5 minutes like fetchData's).
      tools: buildTools(doc, {
        search: (query) => webSearch({ provider: "google", model: SERVER_MODEL }, query),
        fetch: (url) => pageText(url).value,
        onTool: (name, input) => console.info("agent %s %s: %s", c, name, input.slice(0, 200)),
      }),
      stopWhen: isStepCount(MAX_AGENT_STEPS),
      maxOutputTokens: 32000,
      providerOptions,
    });
    // No change to the page (the model only answered): no new version.
    if (doc.html === start.html) return { panel: current ?? undefined, message: result.text };
    const entry = historyEntry(text, origin);
    const requests = [...doc.requests, entry].slice(-MAX_PANEL_REQUESTS);
    return { panel: await panels.savePanel(c, { html: doc.html, requests }, entry), message: result.text };
  } catch (err) {
    console.error("submitRequest failed:", err instanceof Error ? err.message : err);
    return failure(err);
  }
}

function serverAgentIO(code: string) {
  return {
    search: (query: string) => webSearch({ provider: "google", model: SERVER_MODEL }, query),
    fetch: (url: string) => pageText(url).value,
    onTool: (name: string, input: string) => console.info("agent %s %s: %s", code, name, input.slice(0, 200)),
  };
}

// submitRequest with the Structured agent: read_file / write_file on the three JSON parts.
async function submitStructured(
  code: string,
  text: string,
  origin: RequestOrigin,
  current: PanelRecord | null,
): Promise<PanelResult> {
  try {
    const startParts = current?.parts ?? INITIAL_PARTS;
    const work = { parts: structuredClone(startParts), requests: current?.requests ?? [] };
    const { model, providerOptions } = serverModel();
    const result = await generateText({
      model,
      system: STRUCTURED_SYSTEM,
      prompt: buildStructuredPrompt(work, text, origin),
      tools: buildStructuredTools(work, serverAgentIO(code)),
      stopWhen: isStepCount(MAX_AGENT_STEPS),
      maxOutputTokens: 32000,
      providerOptions,
    });
    if (JSON.stringify(work.parts) === JSON.stringify(startParts)) {
      return { panel: current ?? undefined, message: result.text };
    }
    const entry = historyEntry(text, origin);
    const requests = [...work.requests, entry].slice(-MAX_PANEL_REQUESTS);
    const page = parsePanel({ requests, agent: "structured", parts: work.parts, html: "" });
    return { panel: await panels.savePanel(code, page, entry), message: result.text };
  } catch (err) {
    console.error("submitRequest (structured) failed:", err instanceof Error ? err.message : err);
    return failure(err);
  }
}

export type ExtractResult = { data?: unknown; url?: string; fetchedAt?: string; cached?: boolean; error?: string };
export type PageTextResult = { url?: string; text?: string; cached?: boolean; error?: string };

const EXTRACT_LIMIT = 30;
const EXTRACT_WINDOW_MS = 10 * 60_000;
const extractCalls = new Map<string, number[]>();

// Checks sign-in, input and the per-browser rate limit shared by both data actions.
async function dataGuard(url: unknown, instruction: unknown = "x"): Promise<string | null> {
  if (typeof url !== "string" || typeof instruction !== "string" || !instruction.trim()) {
    return "fetchData needs a URL and an instruction.";
  }
  if (url.length > 2000 || instruction.length > 2000) return "URL or instruction too long.";
  const id = await sessionId();
  const now = Date.now();
  const recent = (extractCalls.get(id) ?? []).filter((t) => now - t < EXTRACT_WINDOW_MS);
  if (recent.length >= EXTRACT_LIMIT) return "Too many data requests; try again in a few minutes.";
  recent.push(now);
  extractCalls.set(id, recent);
  return null;
}

// fetchData(url, instruction) on a panel allowed to use the server's model: the server
// reads the page and extracts JSON.
export async function extractData(code: unknown, url: unknown, instruction: unknown): Promise<ExtractResult> {
  const problem = await dataGuard(url, instruction);
  if (problem) return { error: problem };
  try {
    if (!(await serverLlmAllowed(await guard(code)))) return { error: NO_SERVER_LLM };
    const { value, hit } = extractWithServer(url as string, (instruction as string).trim());
    return { ...(await value), cached: hit };
  } catch (err) {
    console.error("extractData failed:", err instanceof Error ? err.message : err);
    return { error: err instanceof Error ? err.message : "Couldn't read that page." };
  }
}

// fetchData otherwise: the server only downloads the page (browsers can't, because of CORS);
// the browser extracts with the user's own model.
export async function fetchPageText(url: unknown): Promise<PageTextResult> {
  const problem = await dataGuard(url);
  if (problem) return { error: problem };
  try {
    const { value, hit } = pageText(url as string);
    return { ...(await value), cached: hit };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't read that page." };
  }
}

export type StateOp = "get" | "set" | "list" | "delete";
export type StateResult = {
  entry?: { key: string; value: unknown; date: string } | null;
  keys?: { key: string; date: string }[];
  deleted?: boolean;
  error?: string;
};

const MAX_STATE_KEY = 200;
const MAX_STATE_BYTES = 100_000;
const STATE_LIMIT = 300;
const STATE_WINDOW_MS = 60_000;
const stateCalls = new Map<string, number[]>();

// Saved state for generated pages (saveState / loadState / listState / deleteState): JSON values
// by key, per panel, in the database, so they follow the panel to other devices.
export async function panelState(code: unknown, op: unknown, key?: unknown, value?: unknown): Promise<StateResult> {
  try {
    const c = await guard(code);
    const id = await sessionId();
    const now = Date.now();
    const recent = (stateCalls.get(id) ?? []).filter((t) => now - t < STATE_WINDOW_MS);
    if (recent.length >= STATE_LIMIT) return { error: "Too many saves; slow down." };
    recent.push(now);
    stateCalls.set(id, recent);

    if (op === "list") {
      const prefix = typeof key === "string" ? key.slice(0, MAX_STATE_KEY) : "";
      return { keys: await panels.listPanelState(c, prefix) };
    }
    if (typeof key !== "string" || !key.trim() || key.length > MAX_STATE_KEY) {
      return { error: `State keys are 1–${MAX_STATE_KEY} characters.` };
    }
    if (op === "get") return { entry: await panels.getPanelState(c, key) };
    if (op === "delete") return { deleted: await panels.deletePanelState(c, key) };
    if (op === "set") {
      let json: string | undefined;
      try {
        json = JSON.stringify(value);
      } catch {}
      if (json === undefined) return { error: "saveState needs a JSON value." };
      if (json.length > MAX_STATE_BYTES) return { error: "That value is too large (100 KB at most)." };
      return { entry: await panels.setPanelState(c, key, JSON.parse(json)) };
    }
    return { error: "Unknown state operation." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't use the saved state." };
  }
}
