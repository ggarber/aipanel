# Voice UI

A voice-driven generative UI. Press the talk button (bottom right), describe a screen, and Claude builds or edits it as HTML.

## Run

```bash
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:3000 in Chrome, Edge or Safari. These browsers support the Web Speech API. In other browsers a text box replaces the mic.

## How it works

- `app/generative-ui.tsx` (client): `SpeechRecognition` transcribes speech. On end it calls the `submitRequest` server action and renders the returned HTML in a sandboxed `<iframe srcDoc>`.
- `app/actions.ts` (server action): AI SDK `generateText` with `claude-opus-5-5` and two tools:
  - `set_html` replaces the whole document.
  - `edit_html` does an exact find/replace for small changes.

  The tools change the session's HTML in place, and the action returns the result.
- `lib/ui-store.ts`: an in-memory store, keyed by an httpOnly session cookie. It holds the last HTML and recent requests. It works for a single server process. Use Redis/KV to keep sessions across restarts or on serverless.
