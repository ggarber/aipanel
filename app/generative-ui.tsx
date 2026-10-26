"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { resetUI, submitRequest } from "./actions";

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

type Status = "idle" | "listening" | "thinking";

export default function GenerativeUI({ initialHtml }: { initialHtml: string }) {
  const [html, setHtml] = useState(initialHtml);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  // true on the server so the button doesn't flash a disabled state before hydration.
  const supported = useSyncExternalStore(
    noopSubscribe,
    () => getRecognitionCtor() !== null,
    () => true,
  );
  const [isPending, startTransition] = useTransition();

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef("");

  const status: Status = isPending ? "thinking" : listening ? "listening" : "idle";

  useEffect(() => {
    return () => recognitionRef.current?.abort();
  }, []);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setTranscript(trimmed);
    setMessage("");
    setError("");
    startTransition(async () => {
      const result = await submitRequest(trimmed);
      if (result.html) setHtml(result.html);
      setMessage(result.message);
      if (result.error) setError(result.error);
    });
  }

  function startListening() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = false;
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

  function toggleTalk() {
    if (isPending) return;
    if (listening) recognitionRef.current?.stop();
    else startListening();
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
        title="Generated UI"
        srcDoc={html}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        className={`h-full w-full border-0 transition-opacity ${isPending ? "opacity-60" : ""}`}
      />

      <div className="pointer-events-none fixed bottom-6 right-6 flex flex-col items-end gap-3">
        {(transcript || message || error) && (
          <div className="pointer-events-auto max-w-sm rounded-2xl bg-zinc-900/90 px-4 py-3 text-sm text-zinc-100 shadow-xl backdrop-blur">
            {transcript && (
              <p className="text-zinc-300">
                <span className="text-zinc-500">You: </span>
                {transcript}
              </p>
            )}
            {status === "thinking" && <p className="mt-1 animate-pulse text-zinc-400">Updating the UI…</p>}
            {message && status !== "thinking" && <p className="mt-1">{message}</p>}
            {error && <p className="mt-1 text-red-400">{error}</p>}
          </div>
        )}

        {!supported && (
          <form
            className="pointer-events-auto flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send(typed);
              setTyped("");
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Speech not supported — type instead"
              className="w-72 rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 shadow"
            />
          </form>
        )}

        <div className="pointer-events-auto flex items-center gap-2">
          <button
            onClick={reset}
            disabled={isPending}
            className="rounded-full bg-white/90 px-3 py-1.5 text-xs text-zinc-600 shadow hover:bg-white disabled:opacity-50"
          >
            Reset
          </button>
          <button
            onClick={toggleTalk}
            disabled={!supported || isPending}
            aria-label={listening ? "Stop listening" : "Talk"}
            className={`relative flex h-16 w-16 items-center justify-center rounded-full text-white shadow-2xl transition
              ${listening ? "bg-red-500 hover:bg-red-600" : "bg-zinc-900 hover:bg-zinc-700"}
              disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {listening && <span className="absolute inset-0 animate-ping rounded-full bg-red-500/50" />}
            {status === "thinking" ? (
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : (
              <svg viewBox="0 0 24 24" className="relative h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
