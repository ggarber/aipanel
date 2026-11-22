"use client";

import { useEffect, useRef, useState } from "react";
import { panelFileName, parsePanelFile, toPanelFile, type PanelData } from "@/lib/panel-file";
import type { StoredPanel } from "@/lib/panel-store";
import { localAvailability } from "@/lib/local-model";
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
  onImported,
}: {
  settings: ModelSettings;
  onClose: () => void;
  panel: StoredPanel | null;
  onImported: (data: PanelData) => void;
}) {
  const [draft, setDraft] = useState(settings);
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
      const file = { ...toPanelFile({ html: panel.html, requests: panel.requests }), code: panel.code, panelVersion: panel.version };
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
      onImported(data);
      onClose();
    } catch (err) {
      setPanelStatus({ text: err instanceof Error ? err.message : "Import failed.", error: true });
    } finally {
      setPanelBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    saveSettings(draft);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/30 p-4"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onSubmit={save}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 text-sm text-zinc-800 shadow-2xl"
      >
        <h2 id="settings-title" className="text-lg font-semibold text-zinc-900">Settings</h2>

        <fieldset className="space-y-2">
          <legend className="mb-1 font-medium">Model</legend>
          {(["server", "local", ...PROVIDER_IDS] as ModelSource[]).map((source) => (
            <label key={source} className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="source"
                value={source}
                checked={draft.source === source}
                onChange={() => setDraft({ ...draft, source })}
              />
              {source === "server"
                ? "Server default (Gemini)"
                : source === "local"
                  ? "In this browser (Chrome built-in Gemini Nano)"
                  : `${PROVIDERS[source].label} with your API key`}
            </label>
          ))}
        </fieldset>

        {draft.source === "local" && (
          <p className="rounded-xl bg-zinc-50 p-4 text-zinc-600">
            {LOCAL_STATUS[local] ?? LOCAL_STATUS.unavailable} Runs on this device; nothing is sent to a model
            provider. It’s a small model, so pages will be simpler.
          </p>
        )}

        {provider && (
          <div className="space-y-3 rounded-xl bg-zinc-50 p-4">
            <label className="block space-y-1">
              <span className="font-medium">{PROVIDERS[provider].label} API key</span>
              <input
                type="password"
                autoComplete="off"
                value={draft.keys[provider] ?? ""}
                onChange={(e) => setDraft({ ...draft, keys: { ...draft.keys, [provider]: e.target.value } })}
                placeholder="Paste your key"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2"
              />
              <span className="block text-xs text-zinc-500">
                Stored only in this browser and sent with each request; the server doesn’t keep it.{" "}
                <a href={PROVIDERS[provider].keyUrl} target="_blank" rel="noreferrer" className="underline">
                  Get a key
                </a>
              </span>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Model name</span>
              <input
                value={draft.models[provider] ?? ""}
                onChange={(e) => setDraft({ ...draft, models: { ...draft.models, [provider]: e.target.value } })}
                placeholder={PROVIDERS[provider].defaultModel}
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono"
              />
            </label>
          </div>
        )}

        <section className="space-y-2 border-t border-zinc-200 pt-4">
          <h3 className="font-medium">Panel</h3>
          <p className="text-xs text-zinc-500">
            Export saves the current page and its request history to a file. Import replaces the current panel with
            one from a file (an export, or a plain .html page).
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={doExport}
              disabled={panelBusy}
              className="rounded-full border border-zinc-300 px-4 py-1.5 hover:bg-zinc-100 disabled:opacity-50"
            >
              Export
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={panelBusy}
              className="rounded-full border border-zinc-300 px-4 py-1.5 hover:bg-zinc-100 disabled:opacity-50"
            >
              Import…
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
            <p role="status" className={`text-xs ${panelStatus.error ? "text-red-600" : "text-zinc-600"}`}>
              {panelStatus.text}
            </p>
          )}
        </section>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-zinc-600 hover:bg-zinc-100">
            Cancel
          </button>
          <button type="submit" className="rounded-full bg-zinc-900 px-4 py-2 font-medium text-white hover:bg-zinc-700">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
