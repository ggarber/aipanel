"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";
import { CODE_LENGTH, isPanelCode, normalizeCode } from "@/lib/panel-code";
import {
  createPanel,
  deletePanel,
  getPanel,
  listPanels,
  panelTitle,
  subscribePanels,
  type StoredPanel,
} from "@/lib/panel-store";

const EMPTY: StoredPanel[] = [];
let cachedList: { key: string; list: StoredPanel[] } = { key: "", list: EMPTY };

// listPanels() builds a new array each call; reuse it while nothing changed.
function panelsSnapshot(): StoredPanel[] {
  const list = listPanels();
  const key = list.map((p) => `${p.code}:${p.version}`).join(",");
  if (key !== cachedList.key) cachedList = { key, list };
  return cachedList.list;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export default function Home() {
  const router = useRouter();
  const panels = useSyncExternalStore(subscribePanels, panelsSnapshot, () => EMPTY);
  const [code, setCode] = useState("");
  const [focused, setFocused] = useState(true);
  const [error, setError] = useState("");
  const [shake, setShake] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function open(e?: React.FormEvent) {
    e?.preventDefault();
    if (!isPanelCode(code)) return;
    if (!getPanel(code)) {
      setError(`No panel ${code} in this browser`);
      setShake((n) => n + 1);
      return;
    }
    router.push(`/p/${code}`);
  }

  function create() {
    try {
      router.push(`/p/${createPanel().code}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="game-bg min-h-screen w-full px-4 pb-16 pt-10">
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-8">
        <header className="game-pop text-center">
          <h1 className="game-title text-6xl sm:text-7xl">AI PANEL</h1>
          <p className="game-outline mt-3 text-xl">Speak it. Build it. Play it.</p>
        </header>

        <form onSubmit={open} className="game-card game-pop w-full max-w-lg p-6 text-center">
          <label htmlFor="panel-code" className="game-outline block text-2xl">
            Enter panel code
          </label>
          <div
            key={shake}
            className={`relative mx-auto mt-5 flex w-fit gap-1.5 sm:gap-2 ${shake ? "game-shake" : ""}`}
            onClick={() => inputRef.current?.focus()}
          >
            {Array.from({ length: CODE_LENGTH }, (_, i) => (
              <span
                key={i}
                aria-hidden="true"
                className="game-slot"
                data-active={focused && i === Math.min(code.length, CODE_LENGTH - 1)}
              >
                {code[i] ?? ""}
              </span>
            ))}
            <input
              ref={inputRef}
              id="panel-code"
              value={code}
              onChange={(e) => {
                setCode(normalizeCode(e.target.value));
                setError("");
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={CODE_LENGTH + 4}
              aria-describedby="code-help"
              className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent outline-none"
            />
          </div>
          <p id="code-help" className="mt-4 min-h-6 text-sm font-semibold">
            {error ? (
              <span className="rounded-lg bg-red-600/90 px-3 py-1 text-white">{error}</span>
            ) : (
              <span className="text-sky-100">8 letters or numbers</span>
            )}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-4">
            <button type="submit" disabled={!isPanelCode(code)} className="game-btn game-btn-gold min-w-36">
              OPEN
            </button>
            <button type="button" onClick={create} className="game-btn game-btn-green min-w-36">
              + NEW PANEL
            </button>
          </div>
        </form>

        {panels.length > 0 && (
          <section className="w-full">
            <h2 className="game-outline mb-4 text-center text-2xl">Your panels</h2>
            <ul className="grid gap-4 sm:grid-cols-2">
              {panels.map((p) => (
                <li key={p.code} className="game-card flex items-center gap-3 p-4">
                  <span className="game-badge" title={`Version ${p.version}`}>
                    v{p.version}
                  </span>
                  <Link href={`/p/${p.code}`} className="min-w-0 flex-1">
                    <span className="game-code-chip text-lg">{p.code}</span>
                    <span className="mt-1 block truncate font-semibold text-white">{panelTitle(p.html)}</span>
                    <span className="block text-xs text-sky-200">Updated {ago(p.updatedAt)}</span>
                  </Link>
                  {confirmDelete === p.code ? (
                    <button
                      type="button"
                      onClick={() => {
                        deletePanel(p.code);
                        setConfirmDelete(null);
                      }}
                      onBlur={() => setConfirmDelete(null)}
                      autoFocus
                      className="game-btn game-btn-red game-btn-sm"
                    >
                      Delete?
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(p.code)}
                      aria-label={`Delete panel ${p.code}`}
                      className="game-btn game-btn-blue game-btn-sm"
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-center text-xs text-sky-200">
              Panels are saved in this browser only. Use Export / Import in a panel’s Settings to move one.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
