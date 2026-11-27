"use client";

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  extractData,
  fetchPageText,
  panelState,
  revertPanel,
  savePanelContent,
  setPanelAgent,
  submitRequest,
  type ExtractResult,
  type PanelResult,
  type RequestOrigin,
} from "./actions";
import { extractWithOwnKey, runStructuredWithOwnKey, runWithOwnKey } from "@/lib/browser-llm";
import { INITIAL_HTML } from "@/lib/initial-html";
import { agentOf, type PanelContent } from "@/lib/panel-types";
import {
  AGENT_LABELS,
  DEFAULT_AGENT,
  INITIAL_PARTS,
  INITIAL_STRUCTURED_HTML,
  partsFromHtml,
  type PanelAgent,
} from "@/lib/structured";
import { cachePanel, getPanel, subscribePanels } from "@/lib/panel-store";
import { historyEntry } from "@/lib/genui";
import { runLocalModel } from "@/lib/local-model";
import {
  describeExtractionModel,
  describeModel,
  getServerSettings,
  getSettings,
  PROVIDERS,
  remoteChoice,
  subscribeSettings,
} from "@/lib/model-settings";
import { seconds, useActivities } from "./activities";
import SettingsDialog from "./settings-dialog";

// Minimal Web Speech API typings (not in lib.dom for all TS versions).
type SpeechRecognitionResultLike = { isFinal: boolean; 0: { transcript: string } };
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const noopSubscribe = () => () => {};

// Injected into every rendered document (not stored server-side) so generated pages can
// call askLLM(request, context) to send a follow-up request back through the LLM, and
// fetchData(url, instruction) to get JSON extracted from a web page by the server.
// Messages wait in a queue until the parent says it's listening (genui:ready). The
// iframe is in the server-rendered HTML, so its scripts can run before React hydrates.
const BRIDGE_SCRIPT = `<script>(function(){
  var ready = false, queue = [];
  function send(msg) { if (ready) parent.postMessage(msg, "*"); else queue.push(msg); }
  window.askLLM = function (request, context) {
    if (typeof request !== "string" || !request.trim()) return;
    // Only from a click or key press: a page that calls it on load, in a timer or in a loop
    // would otherwise regenerate itself forever (each new page calling it again).
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      console.warn("askLLM ignored: call it from a click or key handler");
      return;
    }
    var ctx;
    try { ctx = context === undefined ? undefined : JSON.parse(JSON.stringify(context)); } catch (e) {}
    send({ type: "genui:ask", request: request, context: ctx });
  };
  var pending = {}, next = 0;
  window.fetchData = function (url, instruction) {
    return new Promise(function (resolve, reject) {
      var id = ++next;
      pending[id] = { resolve: resolve, reject: reject };
      send({ type: "genui:fetch", id: id, url: String(url), instruction: String(instruction) });
    });
  };
  // Saved state, kept on the server per panel (follows the panel to other devices).
  function state(op, key, value) {
    return new Promise(function (resolve, reject) {
      var id = ++next, v;
      if (op === "set") {
        try { v = JSON.parse(JSON.stringify(value)); } catch (e) { return reject(new Error("saveState needs a JSON value")); }
      }
      pending[id] = { resolve: resolve, reject: reject, state: op };
      send({ type: "genui:state", id: id, op: op, key: key === undefined ? undefined : String(key), value: v });
    });
  }
  window.saveState = function (key, value) { return state("set", key, value); };
  window.loadState = function (key) { return state("get", key); };
  window.listState = function (prefix) { return state("list", prefix || ""); };
  window.deleteState = function (key) { return state("delete", key); };
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== parent || !d) return;
    if (d.type === "genui:ready" && !ready) {
      ready = true;
      queue.splice(0).forEach(function (m) { parent.postMessage(m, "*"); });
      return;
    }
    if ((d.type !== "genui:fetch:result" && d.type !== "genui:state:result") || !pending[d.id]) return;
    var p = pending[d.id];
    delete pending[d.id];
    if (d.error) p.reject(new Error(d.error));
    else if (d.type === "genui:state:result") {
      // get: {key, value, date} or null; set: {key, value, date}; list: [{key, date}]; delete: true/false
      p.resolve(p.state === "list" ? d.keys : p.state === "delete" ? d.deleted : d.entry);
    } else p.resolve({ data: d.data, url: d.url, fetchedAt: d.fetchedAt });
  });
})();</script>`;

const MAX_FETCHES_IN_FLIGHT = 4;

const NO_SERVER_LLM =
  "This panel can't use the server's model. Pick your own key or the in-browser model in Settings.";

// Content for a panel edited by `agent`: a Structured page from HTML (Gemini Nano's output,
// an imported .html or Classic export) is wrapped into the three parts. The server renders
// the HTML of Structured pages itself.
function contentFor(agent: PanelAgent, data: PanelContent): PanelContent {
  if (agent === "classic") return { html: data.html, requests: data.requests };
  if (data.agent === "structured" && data.parts) return { html: "", requests: data.requests, agent, parts: data.parts };
  return { html: "", requests: data.requests, agent, parts: partsFromHtml(data.html) };
}

function withBridge(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + BRIDGE_SCRIPT + html.slice(at);
  }
  return BRIDGE_SCRIPT + html;
}

type Status = "idle" | "listening" | "thinking";

// Holding the main button this long starts push-to-talk instead of opening the menu.
const HOLD_MS = 300;

export default function GenerativeUI({
  code,
  offline = false,
  serverLlm,
  isNew = false,
}: {
  code: string;
  offline?: boolean;
  // The server doesn't have this code yet: the first change creates the panel.
  isNew?: boolean;
  // Whether this panel may use the server's model (its server_llm flag).
  serverLlm: boolean;
}) {
  // The page shown is always the newest stored version of this panel, so saves from this
  // tab or another one show up here, and an older copy never replaces a newer one.
  const panel = useSyncExternalStore(subscribePanels, () => getPanel(code), () => null);
  // A saved panel keeps the agent it was made with (Classic for every panel from before the
  // Structured agent); a new code uses newAgent (Structured unless changed in Settings) and
  // its first save stores it.
  const [newAgent, setNewAgent] = useState<PanelAgent>(DEFAULT_AGENT);
  const agent: PanelAgent = panel ? agentOf(panel) : newAgent;
  const startHtml = agent === "structured" ? INITIAL_STRUCTURED_HTML : INITIAL_HTML;
  const html = panel?.html ?? startHtml;
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Download progress (0–1) of the built-in model, while it downloads on first use.
  const [download, setDownload] = useState<number | null>(null);
  const settings = useSyncExternalStore(subscribeSettings, getSettings, getServerSettings);
  // true on the server so the button doesn't flash a disabled state before hydration.
  const supported = useSyncExternalStore(
    noopSubscribe,
    () => getRecognitionCtor() !== null,
    () => true,
  );
  const [isPending, startTransition] = useTransition();
  const { activities, begin, update, end } = useActivities();

  const [requestSource, setRequestSource] = useState<RequestOrigin["source"]>("voice");

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Guards against overlapping requests, e.g. a generated page calling askLLM repeatedly.
  const busyRef = useRef(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingRef = useRef(false);
  const skipClickRef = useRef(false);
  const controlsRef = useRef<HTMLDivElement>(null);

  const status: Status = isPending ? "thinking" : listening ? "listening" : "idle";

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    function onPointerDown(e: PointerEvent) {
      if (!controlsRef.current?.contains(e.target as Node)) close();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Clicking into the iframe doesn't reach this document, but it does blur the window.
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [menuOpen]);

  function send(text: string, origin: RequestOrigin = { source: "voice" }) {
    const trimmed = text.trim();
    if (!trimmed || busyRef.current) return;
    busyRef.current = true;
    setRequestSource(origin.source);
    setTranscript(trimmed);
    setMessage("");
    setError("");
    const current = getSettings();
    const model = describeModel(current);
    const what = origin.source === "panel" ? "handle a page action" : "update the page";
    const activity = begin(`Asking ${model} to ${what}…`);
    const started = Date.now();
    startTransition(async () => {
      try {
        const own = remoteChoice(current);
        const result: PanelResult =
          current.source === "local"
            ? await runLocal(trimmed, origin, activity)
            : own
              ? await runOwnKey(trimmed, origin, own, activity, model)
              : !serverLlm
                ? { error: NO_SERVER_LLM }
                : await submitRequest(trimmed, origin, code, getPanel(code)?.html ?? INITIAL_HTML, agent).catch(() => ({
                    error: "Couldn't reach the server.",
                  }));
        if (result.panel) cachePanel(result.panel);
        setMessage(result.message ?? "");
        if (result.error) setError(result.error);
        end(
          activity,
          result.error
            ? { text: `${model} failed: ${result.error}`, error: true }
            : { text: `Page updated by ${model} in ${seconds(Date.now() - started)}` },
        );
      } finally {
        busyRef.current = false;
        setDownload(null);
      }
    });
  }

  // The browser calls the provider with the user's key; the server only stores the page.
  async function runOwnKey(
    text: string,
    origin: RequestOrigin,
    choice: NonNullable<ReturnType<typeof remoteChoice>>,
    activity: number,
    model: string,
  ): Promise<PanelResult> {
    const stored = getPanel(code);
    const doc = stored ?? { html: INITIAL_HTML, requests: [] };
    // Show the agent's research steps in the status line.
    const onTool = (name: "web_search" | "fetch_url", input: string) => {
      let what = input;
      if (name === "fetch_url") {
        try {
          what = new URL(input).hostname;
        } catch {}
      }
      update(activity, name === "web_search" ? `${model}: searching the web for “${what.slice(0, 80)}”…` : `${model}: reading ${what}…`);
    };
    try {
      if (agent === "structured") {
        const parts = stored?.parts ?? (stored ? partsFromHtml(stored.html) : INITIAL_PARTS);
        const requests = stored?.requests ?? [];
        const result = await runStructuredWithOwnKey(choice, { parts, requests }, text, origin, onTool);
        if (!result.changed) return { message: result.message };
        const entry = historyEntry(text, origin);
        const saved = await savePanelContent(
          code,
          { html: "", requests: [...requests, entry], agent: "structured", parts: result.parts },
          entry,
        );
        return { ...saved, message: result.message };
      }
      const result = await runWithOwnKey(choice, doc, text, origin, onTool);
      if (!result.changed) return { message: result.message };
      const entry = historyEntry(text, origin);
      const saved = await savePanelContent(code, { html: result.html, requests: [...doc.requests, entry] }, entry);
      return { ...saved, message: result.message };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "The request failed." };
    }
  }

  // fetchData: with the server's model when the panel allows it; otherwise the server only
  // downloads the page and the browser extracts with the user's own key.
  async function getData(url: unknown, instruction: unknown): Promise<ExtractResult> {
    const current = getSettings();
    const own = remoteChoice(current);
    if (!own) {
      if (serverLlm) return extractData(code, url, instruction);
      return {
        error:
          current.source === "local"
            ? "Live data needs a remote model: add your own key in Settings."
            : NO_SERVER_LLM,
      };
    }
    if (typeof instruction !== "string" || !instruction.trim()) return { error: "fetchData needs an instruction." };
    const page = await fetchPageText(url);
    if (page.error || page.text === undefined || !page.url) return { error: page.error ?? "Couldn't read that page." };
    try {
      const { value, hit } = extractWithOwnKey(own, { url: page.url, text: page.text }, instruction.trim());
      return { data: await value, url: page.url, fetchedAt: new Date().toISOString(), cached: hit };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "The extraction failed." };
    }
  }

  // Gemini Nano makes the page here; the server stores it as the next version.
  async function runLocal(text: string, origin: RequestOrigin, activity: number): Promise<PanelResult> {
    const doc = getPanel(code) ?? { html: startHtml, requests: [] };
    const onProgress = (fraction: number) => {
      setDownload(fraction);
      update(
        activity,
        fraction < 1
          ? `Downloading Gemini Nano into Chrome… ${Math.round(fraction * 100)}%`
          : "Asking Gemini Nano (in this browser, experimental) to update the page…",
      );
    };
    try {
      const fresh = doc.html === INITIAL_HTML || doc.html === INITIAL_STRUCTURED_HTML;
      const result = await runLocalModel({ ...doc, fresh }, text, origin, onProgress);
      const entry = historyEntry(text, origin);
      // Nano writes HTML; a Structured panel stores it wrapped into the three parts.
      const content = contentFor(agent, { html: result.html, requests: [...doc.requests, entry] });
      const saved = await savePanelContent(code, content, entry);
      return { ...saved, message: result.message };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "The built-in model failed." };
    }
  }

  const sendRef = useRef(send);
  const getDataRef = useRef(getData);
  const serverLlmRef = useRef(serverLlm);
  useEffect(() => {
    sendRef.current = send;
    getDataRef.current = getData;
    serverLlmRef.current = serverLlm;
  });

  useEffect(() => {
    let inFlight = 0;
    function onMessage(e: MessageEvent) {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || e.source !== frame) return;
      const data = e.data as {
        type?: unknown;
        request?: unknown;
        context?: unknown;
        id?: unknown;
        url?: unknown;
        instruction?: unknown;
        op?: unknown;
        key?: unknown;
        value?: unknown;
      } | null;
      if (data?.type === "genui:state" && typeof data.id === "number") {
        const id = data.id;
        panelState(code, data.op, data.key, data.value)
          .catch(() => ({ error: "Couldn't reach the server." }))
          .then((result) => {
            frame.postMessage({ type: "genui:state:result", id, ...result }, "*");
            if (result.error) setError(`Saved state: ${result.error}`);
          });
        return;
      }
      if (data?.type === "genui:fetch" && typeof data.id === "number") {
        const id = data.id;
        const reply = (result: object) => frame.postMessage({ type: "genui:fetch:result", id, ...result }, "*");
        if (inFlight >= MAX_FETCHES_IN_FLIGHT) {
          reply({ error: "Too many data requests at once." });
          return;
        }
        inFlight++;
        let host = String(data.url);
        try {
          host = new URL(host).hostname;
        } catch {}
        const model = describeExtractionModel(getSettings(), serverLlmRef.current);
        const activity = begin(`Refreshing data from ${host}: ${model} is reading the page…`);
        const started = Date.now();
        getDataRef.current(data.url, data.instruction)
          .then(
            (result) => {
              reply(result);
              end(
                activity,
                result.error
                  ? { text: `Data from ${host} failed: ${result.error}`, error: true }
                  : result.cached
                    ? { text: `Data from ${host} (cached, under 5 min old)` }
                    : { text: `Data from ${host} refreshed by ${model} in ${seconds(Date.now() - started)}` },
              );
            },
            () => {
              reply({ error: "Couldn't reach the server." });
              end(activity, { text: `Data from ${host} failed: couldn't reach the server`, error: true });
            },
          )
          .finally(() => inFlight--);
        return;
      }
      if (data?.type !== "genui:ask" || typeof data.request !== "string") return;
      sendRef.current(data.request.slice(0, 2000), { source: "panel", context: data.context });
    }
    window.addEventListener("message", onMessage);
    signalReady();
    return () => window.removeEventListener("message", onMessage);
  }, [begin, end, code]);

  // Tells the page's bridge that messages can flow; also sent on every iframe (re)load.
  function signalReady() {
    iframeRef.current?.contentWindow?.postMessage({ type: "genui:ready" }, "*");
  }

  // continuous keeps listening through pauses, for push-to-talk where release ends it.
  function startListening(continuous = false) {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = continuous;
    recognition.interimResults = true;
    finalRef.current = "";

    recognition.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      setTranscript((finalRef.current + interim).trim());
    };
    recognition.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") {
        setError(`Speech recognition error: ${e.error}`);
      }
    };
    const activity = begin(
      continuous ? "Listening (push-to-talk): release to send…" : "Listening… click the button again to send",
    );
    recognition.onend = () => {
      end(activity);
      setListening(false);
      recognitionRef.current = null;
      send(finalRef.current);
    };

    recognitionRef.current = recognition;
    setTranscript("");
    setMessage("");
    setError("");
    setListening(true);
    recognition.start();
  }

  function clearHoldTimer() {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }

  function onMainPointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
    skipClickRef.current = false;
    if (e.button !== 0 || isPending || listening || !supported) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    clearHoldTimer();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      holdingRef.current = true;
      setMenuOpen(false);
      startListening(true);
    }, HOLD_MS);
  }

  function onMainPointerUp() {
    clearHoldTimer();
    if (!holdingRef.current) return;
    holdingRef.current = false;
    skipClickRef.current = true;
    recognitionRef.current?.stop();
  }

  function onMainClick() {
    if (skipClickRef.current) {
      skipClickRef.current = false;
      return;
    }
    if (isPending) return;
    if (listening) recognitionRef.current?.stop();
    else if (!supported) setTextOpen(true);
    // The chat box is open: the button closes it (without speech it stays, it's the only input).
    else if (textOpen) {
      setTextOpen(false);
      setMenuOpen(false);
    } else setMenuOpen((open) => !open);
  }

  function chooseChat() {
    setMenuOpen(false);
    setTextOpen(true);
  }

  function chooseVoice() {
    setMenuOpen(false);
    setTextOpen(false);
    startListening();
  }

  // Reset, Import and Revert: the server saves a new version, and the cache takes it.
  async function saveOnServer(label: string, run: () => Promise<PanelResult>, done: string): Promise<boolean> {
    const activity = begin(`${label}…`);
    const result = await run().catch(() => ({ error: "Couldn't reach the server." }) as PanelResult);
    if (result.panel) cachePanel(result.panel);
    if (result.error) {
      end(activity, { text: result.error, error: true });
      setError(result.error);
      return false;
    }
    setTranscript("");
    setError("");
    setMessage("");
    end(activity, { text: done });
    return true;
  }

  // Back to the welcome page, as a new version (so it can be undone from Versions).
  function reset() {
    return saveOnServer(
      "Resetting the panel",
      () =>
        savePanelContent(
          code,
          agent === "structured"
            ? { html: "", requests: [], agent, parts: INITIAL_PARTS }
            : { html: INITIAL_HTML, requests: [] },
          "Reset",
        ),
      "Panel reset",
    );
  }

  // A saved panel is converted on the server as a new version; a new one just starts with it.
  async function changeAgent(next: PanelAgent): Promise<boolean> {
    if (next === agent) return true;
    if (!getPanel(code)) {
      setNewAgent(next);
      return true;
    }
    return saveOnServer(
      `Switching to the ${AGENT_LABELS[next]} agent`,
      () => setPanelAgent(code, next),
      `Now edited by the ${AGENT_LABELS[next]} agent`,
    );
  }

  return (
    <div className="fixed inset-0 bg-white">
      <iframe
        ref={iframeRef}
        onLoad={signalReady}
        title="Generated UI"
        srcDoc={withBridge(html)}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        className={`h-full w-full border-0 transition-opacity ${isPending ? "opacity-60" : ""}`}
      />

      <div ref={controlsRef} className="pointer-events-none fixed bottom-6 right-6 flex flex-col items-end gap-3">
        {(transcript || message || error) && (
          <div className="game-bubble pointer-events-auto relative max-w-sm py-3 pl-4 pr-9 text-sm">
            <button
              type="button"
              onClick={() => {
                // Hides the box; a running request carries on (the status line shows it) and its
                // result opens the box again.
                setTranscript("");
                setMessage("");
                setError("");
              }}
              aria-label="Close"
              title="Close"
              className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-sky-200 hover:bg-white/15 hover:text-white"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
            {transcript && (
              <p className="text-sky-100">
                <span className="game-font text-amber-300">{requestSource === "panel" ? "Page: " : "You: "}</span>
                {transcript}
              </p>
            )}
            {status === "thinking" && (
              <p className="mt-1 animate-pulse text-sky-200">
                {download !== null && download < 1
                  ? `Downloading the built-in model… ${Math.round(download * 100)}%`
                  : (activities[activities.length - 1]?.text ?? "Updating the UI…")}
              </p>
            )}
            {message && status !== "thinking" && <p className="mt-1">{message}</p>}
            {error && <p className="mt-1 font-semibold text-red-300">{error}</p>}
          </div>
        )}

        {(textOpen || !supported) && (
          <form
            className="pointer-events-auto flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (isPending || !typed.trim()) return;
              send(typed);
              setTyped("");
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && supported) setTextOpen(false);
              }}
              autoFocus
              placeholder={supported ? "Type what you want to see…" : "Speech not supported — type instead"}
              className="game-input w-80 max-w-[calc(100vw-8rem)] px-4 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={isPending || !typed.trim()}
              className="game-btn game-btn-gold game-btn-sm"
            >
              Send
            </button>
          </form>
        )}

        {menuOpen && (
          <div
            role="menu"
            aria-label="Edit with"
            className="game-menu pointer-events-auto flex flex-col"
          >
            <button role="menuitem" onClick={chooseChat} className="flex items-center gap-3 px-5 py-2.5 text-left">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Chat
            </button>
            <button role="menuitem" onClick={chooseVoice} className="flex items-center gap-3 border-t-2 border-[#0e2257]/20 px-5 py-2.5 text-left">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
              </svg>
              Voice
            </button>
          </div>
        )}

        <div className="pointer-events-auto flex items-center gap-2">
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
            title={`Model: ${settings.source === "server" ? "server default" : settings.source === "local" ? "built-in (Chrome)" : PROVIDERS[settings.source].label}`}
            className="game-icon-btn"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            onClick={onMainClick}
            onPointerDown={onMainPointerDown}
            onPointerUp={onMainPointerUp}
            onPointerCancel={onMainPointerUp}
            onContextMenu={(e) => e.preventDefault()}
            disabled={isPending}
            aria-label={listening ? "Stop listening" : "Edit (hold to talk)"}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={`game-orb touch-none select-none [-webkit-touch-callout:none] ${listening ? "game-orb-red" : ""}`}
          >
            {listening && <span className="absolute inset-0 animate-ping rounded-full bg-red-500/50" />}
            {status === "thinking" ? (
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : listening ? (
              <svg viewBox="0 0 24 24" className="relative h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="relative h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          panel={panel}
          serverLlm={serverLlm}
          code={code}
          versionLabel={isNew && !panel ? "new" : `v${panel?.version ?? 0}`}
          offline={offline}
          agent={agent}
          onAgentChange={changeAgent}
          onReset={reset}
          onImport={(imported) =>
            saveOnServer(
              "Importing the panel",
              () => savePanelContent(code, contentFor(agent, imported), "Imported"),
              "Panel imported",
            )
          }
          onRevert={(version) =>
            saveOnServer(`Reverting to v${version}`, () => revertPanel(code, version), `Reverted to v${version}`)
          }
        />
      )}
    </div>
  );
}
