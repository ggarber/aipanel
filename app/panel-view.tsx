"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPanel, openPanel } from "./actions";
import { cachePanel, getPanel, subscribePanels } from "@/lib/panel-store";
import GenerativeUI from "./generative-ui";

type Sync = "checking" | "synced" | "missing" | "offline";

// Shows the cached copy at once, then asks the server for anything newer: the cache only
// takes the server's copy when its version is higher.
export default function PanelView({ code }: { code: string }) {
  const panel = useSyncExternalStore(subscribePanels, () => getPanel(code), () => undefined);
  const [sync, setSync] = useState<Sync>("checking");
  const [uploadError, setUploadError] = useState("");

  useEffect(() => {
    let live = true;
    openPanel(code, getPanel(code)?.version)
      .then((result) => {
        if (!live) return;
        if ("error" in result) return setSync("offline");
        if (result.status === "found") cachePanel(result.panel);
        setSync(result.status === "missing" ? "missing" : "synced");
      })
      .catch(() => live && setSync("offline"));
    return () => {
      live = false;
    };
  }, [code]);

  async function upload() {
    const local = getPanel(code);
    if (!local) return;
    const result = await createPanel(code, { html: local.html, requests: local.requests }).catch(() => ({
      error: "Couldn’t reach the server.",
    }));
    if ("panel" in result && result.panel) {
      // A fresh server record (new id, version 1+) replaces the local-only copy.
      cachePanel(result.panel);
      setSync("synced");
    } else setUploadError(result.error ?? "Upload failed.");
  }

  if (panel === undefined || (panel === null && sync === "checking")) {
    return <div className="game-bg fixed inset-0" />;
  }

  if (sync === "missing") {
    return (
      <main className="game-bg flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
        <p className="game-title text-4xl">Panel not found</p>
        <p className="max-w-sm text-lg font-semibold text-sky-100">
          There’s no panel <span className="game-code-chip">{code}</span> on the server.
          {panel && " This browser has a copy from before panels were stored on the server."}
        </p>
        {uploadError && <p className="rounded-lg bg-red-600/90 px-3 py-1 text-white">{uploadError}</p>}
        <div className="flex gap-4">
          {panel && (
            <button type="button" onClick={upload} className="game-btn game-btn-green">
              Save to server
            </button>
          )}
          <Link href="/" className="game-btn game-btn-gold">
            Back
          </Link>
        </div>
      </main>
    );
  }

  if (!panel) {
    return (
      <main className="game-bg flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
        <p className="game-title text-4xl">Can’t load the panel</p>
        <p className="max-w-sm text-lg font-semibold text-sky-100">The server didn’t answer. Check the connection and try again.</p>
        <Link href="/" className="game-btn game-btn-gold">
          Back
        </Link>
      </main>
    );
  }

  return <GenerativeUI key={code} code={code} offline={sync === "offline"} />;
}
