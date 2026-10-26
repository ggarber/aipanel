"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

export default function LoginForm() {
  const [state, formAction, isPending] = useActionState<LoginState, FormData>(login, { error: "" });

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <form action={formAction} className="w-full max-w-xs space-y-3 rounded-2xl bg-white p-6 shadow-lg">
        <h1 className="text-lg font-semibold text-zinc-900">Voice UI</h1>
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          required
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900"
        />
        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-lg bg-zinc-900 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60"
        >
          {isPending ? "Checking…" : "Enter"}
        </button>
      </form>
    </main>
  );
}
