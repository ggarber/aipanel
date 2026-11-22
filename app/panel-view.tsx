"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { getPanel, subscribePanels } from "@/lib/panel-store";
import GenerativeUI from "./generative-ui";

// Panels exist only in this browser, so the server can't render them: undefined while
// hydrating, null when this browser has no panel with that code.
export default function PanelView({ code }: { code: string }) {
  const panel = useSyncExternalStore(subscribePanels, () => getPanel(code), () => undefined);
  if (panel === undefined) return <div className="fixed inset-0 bg-[#0b1d4a]" />;
  if (panel === null) {
    return (
      <main className="game-bg flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
        <p className="game-title text-4xl">Panel not found</p>
        <p className="max-w-sm text-lg font-semibold text-sky-100">
          There’s no panel <span className="game-code-chip">{code}</span> in this browser. Panels are saved on the
          device that made them; use Export / Import to move one.
        </p>
        <Link href="/" className="game-btn game-btn-gold">
          Back
        </Link>
      </main>
    );
  }
  return <GenerativeUI key={code} code={code} />;
}
