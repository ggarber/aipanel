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

- **`/`** is the game-style home screen. Type a panel's code (8 characters, `A–Z` and `0–9`; lowercase and separators are cleaned up) and press **OPEN**, or press **+ NEW PANEL** to create one with a random code. Below that are the panels saved in this browser, with their version, title and last update, and a two-click delete.
- **`/p/<CODE>`** opens a panel if this browser has it, or shows "Panel not found". Lowercase codes redirect to uppercase, and invalid ones go home.
- Panels exist only on the device that made them. To move one, use Export / Import.
- The password gate (`APP_PASSWORD`) still protects every page. After signing in, you return to the panel you were opening.

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
- **Import** saves an export file, or a plain `.html` page (imported with no history), as the open panel's next version.

## How it works

- `app/generative-ui.tsx` (client): `SpeechRecognition` transcribes speech. On end it calls the `submitRequest` server action and renders the returned HTML in a sandboxed `<iframe srcDoc>`.
- `lib/genui.ts`: the system prompt, prompt builder and document-editing tools, shared by both paths.
- `app/actions.ts` (server action): AI SDK `generateText` with the model from `lib/models.ts` (the server's Gemini by default, or the user's own provider and key) and two tools:
  - `set_html` replaces the whole document.
  - `edit_html` does an exact find/replace for small changes.

  The tools change the session's HTML in place, and the action returns the result. Generated pages use plain JavaScript for local interactions and call the injected `askLLM(request, context)` for anything that needs the model.
- Live data: generated pages call the injected `fetchData(url, instruction)`, which the page can run on load and on a timer. The main page passes it to the `extractData` server action. `lib/crawl.ts` downloads the page (public http(s) hosts only, 10 s timeout, 3 MB cap) and reduces it to text with table rows kept. `lib/extract.ts` then has the selected model return JSON (`Output.json()`). The page renders that JSON itself. Results are cached for 5 minutes per URL + instruction, and each session gets 30 requests per 10 minutes. Sites that build their content with client-side JavaScript have no data in their HTML and won't work.
- `lib/panel-store.ts`: panels live only in the browser's `localStorage`, one key per code (`aipanel:panel:<CODE>`), holding `{ code, version, html, requests, createdAt, updatedAt }`. Every save bumps `version` and records a `note` (the request, "Reset", "Imported", "Reverted to v3"…). The 5 previous versions are kept in `history`, and Settings → Versions lists them with dates and offers **Revert**. A revert saves the old page as a new version, so it can be undone. If storage is full, the oldest saved versions are dropped first. The panel view always shows the newest stored version, so a save in another tab shows up, and an older copy never replaces a newer one. The server keeps no panel state: `submitRequest` gets the current page and history from the browser and returns the new ones.
- `lib/auth.ts`: a password gate. The page and server actions require a cookie that is set after entering `APP_PASSWORD`.
