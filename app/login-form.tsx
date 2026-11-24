"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

export default function LoginForm({ next }: { next?: string }) {
  const [state, formAction, isPending] = useActionState<LoginState, FormData>(login, { error: "" });

  return (
    <main className="game-bg flex min-h-screen flex-col items-center justify-center gap-8 px-4">
      <h1 className="game-title game-pop text-6xl">AI PANEL</h1>
      <form action={formAction} className="game-card game-pop w-full max-w-xs space-y-4 p-6 text-center">
        <label htmlFor="password" className="game-outline block text-2xl">
          Enter password
        </label>
        {next && <input type="hidden" name="next" value={next} />}
        <input
          type="password"
          id="password"
          name="password"
          placeholder="Password"
          autoFocus
          required
          className="game-input w-full px-3 py-2 text-center"
        />
        {state.error && <p className="rounded-lg bg-red-600/90 px-3 py-1 text-sm font-semibold text-white">{state.error}</p>}
        <button
          type="submit"
          disabled={isPending}
          className="game-btn game-btn-gold w-full"
        >
          {isPending ? "CHECKING…" : "ENTER"}
        </button>
      </form>
    </main>
  );
}
