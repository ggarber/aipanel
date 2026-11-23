# Voice UI

A voice-driven generative UI. Use the edit button (bottom right) to describe a screen, and the model builds or edits it as HTML:

- **Click** it to choose **Chat** (type the request) or **Voice** (speak it; click again to stop).
- **Hold** it to talk right away (push-to-talk); release to send.

## Run

```bash
cp .env.example .env.local   # add GOOGLE_GENERATIVE_AI_API_KEY and APP_PASSWORD
npm run dev
```

Open http://localhost:3000 in Chrome, Edge or Safari.

## Panels and codes

- **A panel** has an `id`, generated and never changing, and a **code** you choose: 8 characters, `A–Z` and `0–9`.
- **`/`** is the game-style home screen. Type a code, then press **OPEN** to open that panel, or **+ CREATE** to claim the code for a new panel. 🎲 suggests a random code. "Recent panels" lists the panels opened in this browser; ✕ removes one from the list, and the panel stays on the server.
- **`/p/<CODE>`** opens a panel from any device. Lowercase codes redirect to uppercase, and invalid ones go home.
- **Storage:** the server database (Neon Postgres, `lib/panels-db.ts`) is the source of truth for each panel and its last 5 versions. The browser keeps a cached copy (`lib/panel-store.ts`, `localStorage`) and shows it immediately, then asks the server and takes its copy only if the version is newer. If the server can't be reached, the cached copy stays on screen marked "offline (cached)".
- **Versions:** every save on the server bumps `version`, records a `note` (the request, "Reset", "Imported", "Reverted to v3"…) and moves the previous version into `history`, keeping 5. Settings → Versions lists them with dates and offers **Revert**, which saves the old page as a new version so it can be undone.
- Panels made before the database existed only live in the browser that made them. Opening one offers **Save to server**.
- The password gate (`APP_PASSWORD`) still protects every page. After signing in you return to the panel you were opening.

### Database

Neon Postgres from the Vercel Marketplace, which sets `DATABASE_URL` on the project (Preview and Production). For local dev, add `DATABASE_URL` to `.env.local`. Without it the server uses an in-memory store with the same behaviour, which loses its data on restart.

The table is created on first use (`lib/panels-db.ts`):

```sql
CREATE TABLE panels (
  id uuid PRIMARY KEY,           -- generated
  code text NOT NULL UNIQUE,     -- chosen by the user
  version integer NOT NULL,
  record jsonb NOT NULL,         -- PanelRecord: page, requests, note, history (last 5)
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- A code is claimed with `INSERT … ON CONFLICT (code) DO NOTHING`.
- A save is `UPDATE … WHERE id = $id AND version = $expected`, retried on conflict, so concurrent saves each get their own version and none is lost; the last one wins.
- Records are kept under ~900 KB by dropping the oldest versions.

## Models

The gear button opens Settings. The choice is saved in this browser.

- **Server default:** Gemini (`gemini-3.8-flash`) with the server's `GOOGLE_GENERATIVE_AI_API_KEY`.
- **Gemini / OpenAI / Anthropic with your own key:** the key and model name are stored in this browser's `localStorage` and sent with each request. The server uses them for that call only. It never stores or logs them (`logging.serverFunctions` is off in `next.config.ts`, since dev logs would print action arguments).
- **In this browser:** Chrome's built-in Gemini Nano via the [Prompt API](https://developer.chrome.com/docs/ai/prompt-api). It needs a recent desktop Chrome, and Chrome downloads the model (a few GB) on first use. The model runs in the page with a short prompt of its own (`lib/local-model.ts`), because its context window is about 9k tokens and it handles neither tools nor long JSON well. It returns the whole new document as plain HTML, which is saved back to the session. These browsers support the Web Speech API. In other browsers a text box replaces the mic.

## Status line

A bar along the bottom (`app/status-bar.tsx`) shows what is running right now, with a live timer:
- an LLM call, with the model and where it runs (server Gemini, your own key, or Gemini Nano in the browser);
- the Gemini Nano download progress;
- `fetchData` refreshes, with the site and the model reading it;
- listening and Reset.

When nothing is running, it shows the last outcome with its time: how long a call took, "cached" for data under 5 minutes old, or the error. The current model is always shown on the right.

## Export and import

Settings → Panel:
- **Export** downloads `aipanel-<CODE>-<date>.json`: `{"format": "aipanel", "version": 1, "exportedAt", "html", "requests", "code", "panelVersion"}` (`lib/panel-file.ts`).
- **Import** saves an export file, or a plain `.html` page (imported with no history), as the open panel's next version on the server.

## How it works

- `app/generative-ui.tsx` (client): `SpeechRecognition` transcribes speech. On end it calls the `submitRequest` server action and renders the returned HTML in a sandboxed `<iframe srcDoc>`.
- `lib/genui.ts`: the system prompt, prompt builder and document-editing tools, shared by both paths.
- `app/actions.ts` (server action): AI SDK `generateText` with the model from `lib/models.ts` (the server's Gemini by default, or the user's own provider and key) and two tools:
  - `set_html` replaces the whole document.
  - `edit_html` does an exact find/replace for small changes.

  The tools change the session's HTML in place, and the action returns the result. Generated pages use plain JavaScript for local interactions and call the injected `askLLM(request, context)` for anything that needs the model.
- Live data: generated pages call the injected `fetchData(url, instruction)`, which the page can run on load and on a timer. The main page passes it to the `extractData` server action. `lib/crawl.ts` downloads the page (public http(s) hosts only, 10 s timeout, 3 MB cap) and reduces it to text with table rows kept. `lib/extract.ts` then has the selected model return JSON (`Output.json()`). The page renders that JSON itself. Results are cached for 5 minutes per URL + instruction, and each session gets 30 requests per 10 minutes. Sites that build their content with client-side JavaScript have no data in their HTML and won't work.
- `lib/panels-db.ts` (server): panels in Postgres; see [Database](#database). `submitRequest(text, origin, model, code)` loads the panel, runs the model and saves the next version. `openPanel`, `createPanel`, `savePanelContent` (local model, Import, Reset) and `revertPanel` are the other panel actions.
- `lib/panel-store.ts` (browser): the `localStorage` cache of server records. `cachePanel` only stores a copy whose version is newer than the cached one.
- `lib/auth.ts`: a password gate. The page and server actions require a cookie that is set after entering `APP_PASSWORD`.
