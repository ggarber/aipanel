"use client";

import { useCallback, useRef, useState } from "react";

type Activity = { id: number; text: string; startedAt: number };
type Outcome = { text: string; error?: boolean; at: number };

// Tracks what the app is doing (LLM calls, research steps, data refreshes, listening…); the
// message box shows the latest one while a request runs.
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
