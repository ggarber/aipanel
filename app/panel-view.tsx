"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { openPanel } from "./actions";
import { cachePanel, getPanel, subscribePanels } from "@/lib/panel-store";
import GenerativeUI from "./generative-ui";

type Server = { state: "checking" } | { state: "offline" } | { state: "ok"; exists: boolean; serverLlm: boolean };

// Shows the cached copy at once, then asks the server: it takes the server's copy only when
// that version is newer. A code the server doesn't know opens empty; its first change
// creates the panel.
export default function PanelView({ code }: { code: string }) {
  const cached = useSyncExternalStore(subscribePanels, () => getPanel(code), () => undefined);
  const [server, setServer] = useState<Server>({ state: "checking" });

  useEffect(() => {
    let live = true;
    openPanel(code, getPanel(code)?.version)
      .then((result) => {
        if (!live) return;
        if ("error" in result) return setServer({ state: "offline" });
        if (result.status === "found") {
          cachePanel(result.panel);
          return setServer({ state: "ok", exists: true, serverLlm: result.panel.serverLlm });
        }
        setServer({ state: "ok", exists: result.status === "current", serverLlm: result.serverLlm });
      })
      .catch(() => live && setServer({ state: "offline" }));
    return () => {
      live = false;
    };
  }, [code]);

  // Nothing cached: wait for the server before showing anything.
  if (cached === undefined || (!cached && server.state === "checking")) {
    return (
      <div className="game-bg fixed inset-0 grid place-items-center">
        <p className="game-outline animate-pulse text-2xl">Loading {code}…</p>
      </div>
    );
  }

  const serverLlm = server.state === "ok" ? server.serverLlm : (cached?.serverLlm ?? false);
  return (
    <GenerativeUI
      key={code}
      code={code}
      serverLlm={serverLlm}
      offline={server.state === "offline"}
      isNew={server.state === "ok" && !server.exists}
    />
  );
}
