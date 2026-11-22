"use client";

import { useEffect, useState } from "react";
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
}: {
  settings: ModelSettings;
  onClose: () => void;
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
