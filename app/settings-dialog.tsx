"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { panelFileName, parsePanelFile, toPanelFile, type PanelData } from "@/lib/panel-file";
import { panelTitle, type StoredPanel } from "@/lib/panel-store";
import { localAvailability } from "@/lib/local-model";
import { AGENT_LABELS, type PanelAgent } from "@/lib/structured";
import {
  PROVIDER_IDS,
  PROVIDERS,
  isProviderId,
  saveSettings,
  type ModelSettings,
  type ModelSource,
} from "@/lib/model-settings";

const LOCAL_STATUS: Record<string, string> = {
  checking: "Checking this browser…",
  available: "Ready.",
  downloadable: "Chrome downloads the model (a few GB) on first use.",
  downloading: "Chrome is downloading the model.",
  unavailable: "Not available here: it needs a recent desktop Chrome on a capable device.",
};

export default function SettingsDialog({
  settings,
  onClose,
  panel,
  serverLlm,
  code,
  versionLabel,
  offline,
  agent,
  onAgentChange,
  onReset,
  onImport,
  onRevert,
}: {
  settings: ModelSettings;
  onClose: () => void;
  panel: StoredPanel | null;
  serverLlm: boolean;
  code: string;
  versionLabel: string;
  offline: boolean;
  agent: PanelAgent;
  onAgentChange: (agent: PanelAgent) => Promise<boolean>;
  onReset: () => Promise<boolean>;
  onImport: (data: PanelData) => Promise<boolean>;
  onRevert: (version: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(settings);
  const [agentDraft, setAgentDraft] = useState(agent);
  const provider = isProviderId(draft.source) ? draft.source : null;
  const [local, setLocal] = useState<string>("checking");

  useEffect(() => {
    let live = true;
    localAvailability().then((a) => live && setLocal(a));
    return () => {
      live = false;
    };
  }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const [panelStatus, setPanelStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);

  async function doExport() {
    setPanelBusy(true);
    setPanelStatus(null);
    try {
      if (!panel) throw new Error("Nothing to export yet.");
      const data: PanelData =
        panel.agent === "structured" && panel.parts
          ? { html: panel.html, requests: panel.requests, agent: panel.agent, parts: panel.parts }
          : { html: panel.html, requests: panel.requests };
      const file = { ...toPanelFile(data), code: panel.code, panelVersion: panel.version };
      const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = panelFileName(panel.code);
      a.click();
      URL.revokeObjectURL(url);
      setPanelStatus({ text: `Exported ${a.download}.` });
    } catch (err) {
      setPanelStatus({ text: err instanceof Error ? err.message : "Export failed.", error: true });
    } finally {
      setPanelBusy(false);
    }
  }

  async function doImport(file: File) {
    setPanelBusy(true);
    setPanelStatus(null);
    try {
      const data = parsePanelFile(await file.text());
      if (!data.html.trim()) throw new Error("The file has no page in it.");
      if (await onImport(data)) onClose();
      else throw new Error("Import failed.");
    } catch (err) {
      setPanelStatus({ text: err instanceof Error ? err.message : "Import failed.", error: true });
    } finally {
      setPanelBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const [confirmReset, setConfirmReset] = useState(false);

  async function reset() {
    if (!confirmReset) return setConfirmReset(true);
    setPanelBusy(true);
    const ok = await onReset();
    setPanelBusy(false);
    if (ok) onClose();
    else setPanelStatus({ text: "Couldn’t reset the panel.", error: true });
  }

  async function revert(version: number) {
    setPanelBusy(true);
    const ok = await onRevert(version);
    setPanelBusy(false);
    if (ok) onClose();
    else setPanelStatus({ text: `Couldn't revert to v${version}.`, error: true });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    saveSettings(draft);
    if (agentDraft !== agent) {
      setPanelBusy(true);
      const ok = await onAgentChange(agentDraft);
      setPanelBusy(false);
      if (!ok) return setPanelStatus({ text: `Couldn't switch to the ${AGENT_LABELS[agentDraft]} agent.`, error: true });
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-[#0a1430]/60 p-4 backdrop-blur-[2px]"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onSubmit={save}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="game-dialog game-pop max-h-[calc(100dvh-2rem)] w-full max-w-md space-y-4 overflow-y-auto p-6 text-sm"
      >
        <h2 id="settings-title" className="game-title text-center text-4xl">Settings</h2>
        <div className="flex items-center justify-between gap-2">
          <span className="game-code-chip text-sm">
            {code} · {versionLabel}
          </span>
          {offline && <span className="text-xs font-semibold text-red-200">Offline: showing the cached copy</span>}
          <Link href="/" className="game-btn game-btn-blue game-btn-sm">
            Home
          </Link>
        </div>

        <fieldset className="space-y-2">
          <legend className="game-outline mb-2 text-lg">Model</legend>
          {(["server", "local", ...PROVIDER_IDS] as ModelSource[]).map((source) => (
            <label key={source} className="flex cursor-pointer items-center gap-2 font-semibold has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
              <input
                type="radio"
                name="source"
                value={source}
                checked={draft.source === source}
                disabled={source === "server" && !serverLlm}
                onChange={() => setDraft({ ...draft, source })}
              />
              {source === "server"
                ? serverLlm
                  ? "Server (Gemini, the app’s key)"
                  : "Server (not enabled for this panel)"
                : source === "local"
                  ? "In this browser (Gemini Nano, experimental)"
                  : `${PROVIDERS[source].label} with your API key`}
            </label>
          ))}
        </fieldset>

        {draft.source === "local" && (
          <p className="game-well p-4 text-sky-100">
            <strong className="mb-1 block text-amber-300">Experimental and very inaccurate.</strong>
            Gemini Nano is a tiny model: expect simple, often wrong or half-finished pages. Use a remote model
            for anything that matters. {LOCAL_STATUS[local] ?? LOCAL_STATUS.unavailable} Runs on this device;
            nothing is sent to a model provider.
          </p>
        )}

        {provider && (
          <div className="game-well space-y-3 p-4">
            <label className="block space-y-1">
              <span className="game-outline">{PROVIDERS[provider].label} API key</span>
              <input
                type="password"
                autoComplete="off"
                value={draft.keys[provider] ?? ""}
                onChange={(e) => setDraft({ ...draft, keys: { ...draft.keys, [provider]: e.target.value } })}
                placeholder="Paste your key"
                className="game-input w-full px-3 py-2"
              />
              <span className="block text-xs text-sky-100">
                Stored only in this browser. Requests go straight from this browser to {PROVIDERS[provider].label}; our server never sees the key.{" "}
                <a href={PROVIDERS[provider].keyUrl} target="_blank" rel="noreferrer" className="underline">
                  Get a key
                </a>
              </span>
            </label>
            <label className="block space-y-1">
              <span className="game-outline">Model name</span>
              <input
                value={draft.models[provider] ?? ""}
                onChange={(e) => setDraft({ ...draft, models: { ...draft.models, [provider]: e.target.value } })}
                placeholder={PROVIDERS[provider].defaultModel}
                className="game-input w-full px-3 py-2 font-mono"
              />
            </label>
          </div>
        )}

        <div className="border-t-2 border-[#0e2257]/40 pt-4">
          <fieldset className="space-y-2">
            <legend className="game-outline mb-2 text-lg">Agent</legend>
            {(["structured", "classic"] as PanelAgent[]).map((a) => (
              <label key={a} className="flex cursor-pointer items-start gap-2 font-semibold">
                <input
                  type="radio"
                  name="agent"
                  value={a}
                  checked={agentDraft === a}
                  onChange={() => setAgentDraft(a)}
                  className="mt-1"
                />
                <span>
                  {AGENT_LABELS[a]}
                  <span className="block text-xs font-normal text-sky-100">
                    {a === "structured"
                      ? "The page is kept as three JSON parts (instructions, style, structure) and the agent edits them path by path. Default for new panels."
                      : "The page is one HTML document that the agent rewrites or edits by find and replace. Panels made before the Structured agent use it."}
                  </span>
                </span>
              </label>
            ))}
            {agentDraft !== agent && panel && (
              <p className="game-well p-3 text-xs text-sky-100">
                Saving converts this page once, as a new version you can revert. Gemini Nano always writes plain HTML,
                which a Structured panel stores as a single raw node.
              </p>
            )}
          </fieldset>
        </div>

        {panel && (
          <section className="space-y-2 border-t-2 border-[#0e2257]/40 pt-4">
            <h3 className="game-outline text-lg">Versions</h3>
            <ol className="game-well max-h-56 space-y-1 overflow-y-auto p-1.5">
              {[
                { version: panel.version, html: panel.html, agent: panel.agent, note: panel.note, savedAt: panel.updatedAt, current: true },
                ...panel.history.map((v) => ({ ...v, current: false })),
              ].map((v) => (
                <li key={v.version} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/10">
                  <span className="game-badge h-8 min-w-8 shrink-0 text-xs">v{v.version}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={v.note}>
                      {v.note || "—"}
                      <span className="text-sky-200">
                        {" "}
                        · {panelTitle(v.html)}
                        {v.agent === "structured" ? " · Structured" : ""}
                      </span>
                    </span>
                    <time dateTime={v.savedAt} className="block text-xs text-sky-200">
                      {new Date(v.savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                    </time>
                  </span>
                  {v.current ? (
                    <span className="game-font shrink-0 rounded-lg border-2 border-[#0e2257] bg-emerald-400 px-2 py-0.5 text-xs text-[#0e2257]">
                      Current
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => revert(v.version)}
                      disabled={panelBusy}
                      className="game-btn game-btn-gold game-btn-sm shrink-0"
                    >
                      Revert
                    </button>
                  )}
                </li>
              ))}
            </ol>
            <p className="text-xs text-sky-100">
              The last 5 versions before the current one are kept on the server (and cached here). Reverting saves the old page as a new
              version, so you can undo it.
            </p>
          </section>
        )}

        <section className="space-y-2 border-t-2 border-[#0e2257]/40 pt-4">
          <h3 className="game-outline text-lg">Panel</h3>
          <p className="text-xs text-sky-100">
            Export saves the current page and its request history to a file. Import replaces the current panel with
            one from a file (an export, or a plain .html page). Reset goes back to the empty welcome page (undo it from
            Versions).
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={doExport}
              disabled={panelBusy}
              className="game-btn game-btn-blue game-btn-sm"
            >
              Export
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={panelBusy}
              className="game-btn game-btn-blue game-btn-sm"
            >
              Import…
            </button>
            <button
              type="button"
              onClick={reset}
              onBlur={() => setConfirmReset(false)}
              disabled={panelBusy}
              className="game-btn game-btn-red game-btn-sm"
            >
              {confirmReset ? "Reset page?" : "Reset"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.html,.htm,application/json,text/html"
              className="hidden"
              aria-label="Panel file to import"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) doImport(file);
              }}
            />
          </div>
          {panelStatus && (
            <p role="status" className={`text-xs font-semibold ${panelStatus.error ? "text-red-200" : "text-sky-100"}`}>
              {panelStatus.text}
            </p>
          )}
        </section>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="game-btn game-btn-blue game-btn-sm">
            Cancel
          </button>
          <button type="submit" disabled={panelBusy} className="game-btn game-btn-green game-btn-sm">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
