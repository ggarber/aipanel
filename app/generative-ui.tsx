"use client";

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  extractData,
  getLocalContext,
  resetUI,
  saveLocalResult,
  submitRequest,
  type RequestOrigin,
} from "./actions";
import { historyEntry } from "@/lib/genui";
import { runLocalModel } from "@/lib/local-model";
import {
  getServerSettings,
  getSettings,
  PROVIDERS,
  remoteChoice,
  subscribeSettings,
} from "@/lib/model-settings";
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
const BRIDGE_SCRIPT = `<script>(function(){
  window.askLLM = function (request, context) {
    if (typeof request !== "string" || !request.trim()) return;
    var ctx;
    try { ctx = context === undefined ? undefined : JSON.parse(JSON.stringify(context)); } catch (e) {}
    parent.postMessage({ type: "genui:ask", request: request, context: ctx }, "*");
  };
  var pending = {}, next = 0;
  window.fetchData = function (url, instruction) {
    return new Promise(function (resolve, reject) {
      var id = ++next;
      pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ type: "genui:fetch", id: id, url: String(url), instruction: String(instruction) }, "*");
    });
  };
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== parent || !d || d.type !== "genui:fetch:result" || !pending[d.id]) return;
    var p = pending[d.id];
    delete pending[d.id];
    if (d.error) p.reject(new Error(d.error));
    else p.resolve({ data: d.data, url: d.url, fetchedAt: d.fetchedAt });
  });
})();</script>`;

const MAX_FETCHES_IN_FLIGHT = 4;

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

export default function GenerativeUI({ initialHtml }: { initialHtml: string }) {
  const [html, setHtml] = useState(initialHtml);
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
    startTransition(async () => {
      try {
        const result =
          getSettings().source === "local"
            ? await runLocal(trimmed, origin)
            : await submitRequest(trimmed, origin, remoteChoice(getSettings()));
        if (result.html) setHtml(result.html);
        setMessage(result.message);
        if (result.error) setError(result.error);
      } finally {
        busyRef.current = false;
        setDownload(null);
      }
    });
  }

  async function runLocal(text: string, origin: RequestOrigin) {
    try {
      const doc = await getLocalContext();
      const result = await runLocalModel(doc, text, origin, setDownload);
      await saveLocalResult(result.html, historyEntry(text, origin));
      return { ...result, error: undefined };
    } catch (err) {
      return { html: "", message: "", error: err instanceof Error ? err.message : "The built-in model failed." };
    }
  }

  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
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
      } | null;
      if (data?.type === "genui:fetch" && typeof data.id === "number") {
        const id = data.id;
        const reply = (result: object) => frame.postMessage({ type: "genui:fetch:result", id, ...result }, "*");
        if (inFlight >= MAX_FETCHES_IN_FLIGHT) {
          reply({ error: "Too many data requests at once." });
          return;
        }
        inFlight++;
        extractData(data.url, data.instruction, remoteChoice(getSettings()))
          .then(reply, () => reply({ error: "Couldn't reach the server." }))
          .finally(() => inFlight--);
        return;
      }
      if (data?.type !== "genui:ask" || typeof data.request !== "string") return;
      sendRef.current(data.request.slice(0, 2000), { source: "panel", context: data.context });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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
    recognition.onend = () => {
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
    else setMenuOpen((open) => !open);
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

  function reset() {
    startTransition(async () => {
      setHtml(await resetUI());
      setTranscript("");
      setMessage("");
      setError("");
    });
  }

  return (
    <div className="fixed inset-0 bg-white">
      <iframe
        ref={iframeRef}
        title="Generated UI"
        srcDoc={withBridge(html)}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        className={`h-full w-full border-0 transition-opacity ${isPending ? "opacity-60" : ""}`}
      />

      <div ref={controlsRef} className="pointer-events-none fixed bottom-6 right-6 flex flex-col items-end gap-3">
        {(transcript || message || error) && (
          <div className="pointer-events-auto max-w-sm rounded-2xl bg-zinc-900/90 px-4 py-3 text-sm text-zinc-100 shadow-xl backdrop-blur">
            {transcript && (
              <p className="text-zinc-300">
                <span className="text-zinc-500">{requestSource === "panel" ? "Page: " : "You: "}</span>
                {transcript}
              </p>
            )}
            {status === "thinking" && (
              <p className="mt-1 animate-pulse text-zinc-400">
                {download !== null && download < 1
                  ? `Downloading the built-in model… ${Math.round(download * 100)}%`
                  : "Updating the UI…"}
              </p>
            )}
            {message && status !== "thinking" && <p className="mt-1">{message}</p>}
            {error && <p className="mt-1 text-red-400">{error}</p>}
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
              className="w-80 max-w-[calc(100vw-3rem)] rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 shadow"
            />
            <button
              type="submit"
              disabled={isPending || !typed.trim()}
              className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow hover:bg-zinc-700 disabled:opacity-50"
            >
              Send
            </button>
          </form>
        )}

        {menuOpen && (
          <div
            role="menu"
            aria-label="Edit with"
            className="pointer-events-auto flex flex-col overflow-hidden rounded-2xl bg-white text-sm text-zinc-800 shadow-xl ring-1 ring-zinc-200"
          >
            <button role="menuitem" onClick={chooseChat} className="flex items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-100">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Chat
            </button>
            <button role="menuitem" onClick={chooseVoice} className="flex items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-100">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-zinc-600 shadow hover:bg-white"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            onClick={reset}
            disabled={isPending}
            className="rounded-full bg-white/90 px-3 py-1.5 text-xs text-zinc-600 shadow hover:bg-white disabled:opacity-50"
          >
            Reset
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
            className={`relative flex h-16 w-16 touch-none select-none items-center justify-center rounded-full text-white shadow-2xl transition [-webkit-touch-callout:none]
              ${listening ? "bg-red-500 hover:bg-red-600" : "bg-zinc-900 hover:bg-zinc-700"}
              disabled:cursor-not-allowed disabled:opacity-60`}
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
      {settingsOpen && <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
