"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Activity = { id: number; text: string; startedAt: number };
type Outcome = { text: string; error?: boolean; at: number };

// Tracks what the app is doing (LLM calls, data refreshes, listening…) for the status line.
export function useActivities() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [last, setLast] = useState<Outcome | null>(null);
  const nextId = useRef(0);

  const begin = useCallback((text: string) => {
    const id = ++nextId.current;
    setActivities((list) => [...list, { id, text, startedAt: Date.now() }]);
    return id;
  }, []);

  const update = useCallback((id: number, text: string) => {
    setActivities((list) => list.map((a) => (a.id === id ? { ...a, text } : a)));
  }, []);

  // outcome: what to show once it's over; omit to end silently.
  const end = useCallback((id: number, outcome?: { text: string; error?: boolean }) => {
    setActivities((list) => list.filter((a) => a.id !== id));
    if (outcome) setLast({ ...outcome, at: Date.now() });
  }, []);

  const note = useCallback((text: string, error?: boolean) => setLast({ text, error, at: Date.now() }), []);

  return { activities, last, begin, update, end, note };
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function StatusBar({
  activities,
  last,
  model,
  panel,
}: {
  activities: Activity[];
  last: Outcome | null;
  model: string;
  panel?: React.ReactNode;
}) {
  const [now, setNow] = useState(0);
  const busy = activities.length > 0;

  useEffect(() => {
    if (!busy) return;
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 500);
    const first = setTimeout(tick, 0);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
    };
  }, [busy]);

  const current = activities[activities.length - 1];

  return (
    <div
      role="status"
      aria-live="polite"
      className="game-statusbar fixed inset-x-0 bottom-0 z-[5] flex h-7 items-center gap-3 px-3 text-xs"
    >
      {current ? (
        <>
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full border border-[#0a1430] bg-amber-300" />
          <span className="min-w-0 truncate">
            {current.text}
            {now > current.startedAt && <span className="text-sky-300/70"> · {seconds(now - current.startedAt)}</span>}
            {activities.length > 1 && <span className="text-sky-300/70"> · +{activities.length - 1} more</span>}
          </span>
        </>
      ) : (
        <>
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full border border-[#0a1430] ${last?.error ? "bg-red-400" : "bg-emerald-400"}`} />
          <span className={`min-w-0 truncate ${last?.error ? "text-red-300" : ""}`}>
            {last ? (
              <>
                {last.text} <span className="text-sky-300/70">· {clock(last.at)}</span>
              </>
            ) : (
              "Ready"
            )}
          </span>
        </>
      )}
      <span className="ml-auto hidden shrink-0 text-sky-300/80 sm:inline">{model}</span>
      {panel && <span className="shrink-0">{panel}</span>}
    </div>
  );
}
