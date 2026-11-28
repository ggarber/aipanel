# Voice UI

A voice-driven generative UI. Use the edit button (bottom right) to describe a screen, and the model builds or edits it as HTML:

- **Click** it to choose **Chat** (type the request) or **Voice** (speak it; click again to stop). Clicking it while the chat box is open closes the chat box.
- **Hold** it to talk right away (push-to-talk); release to send.

## Run

```bash
cp .env.example .env.local   # add GOOGLE_GENERATIVE_AI_API_KEY (and DATABASE_URL to use Postgres)
npm run dev
```

Open http://localhost:3000 in Chrome, Edge or Safari. These browsers support the Web Speech API. In other browsers a text box replaces the mic.

## Panels and codes

- **A panel** has an `id`, generated and never changing, and a **code** you choose: 8 characters, `A–Z` and `0–9`.
- **`/`** is the game-style home screen. Type a code and press **OPEN**. The server is asked whether that panel exists: if it does, it is downloaded and shown; if not, the panel opens empty and its **first change creates it** on the server. 🎲 suggests a random code. "Recent panels" lists the panels opened in this browser; ✕ removes one from the list, and the panel stays on the server.
- **Every change is stored on the server**, whichever model made it: Gemini Nano in the browser, your own key (called from the browser), or the server's model.
- **`/p/<CODE>`** opens a panel from any device. Lowercase codes redirect to uppercase, and invalid ones go home.
- **Storage:** the server database (Neon Postgres, `lib/panels-db.ts`) is the source of truth for each panel and its last 5 versions. The browser keeps a cached copy (`lib/panel-store.ts`, `localStorage`) and shows it immediately, then asks the server and takes its copy only if the version is newer. If the server can't be reached, the cached copy stays on screen marked "offline (cached)".
- **Versions:** every save on the server bumps `version`, records a `note` (the request, "Reset", "Imported", "Reverted to v3"…) and moves the previous version into `history`, keeping 5. Settings → Versions lists them with dates and offers **Revert**, which saves the old page as a new version so it can be undone.
- Panels made before the database existed only live in the browser that made them. Opening one offers **Save to server**.
- **No sign-in: the panel code is the access.** Anyone who knows a code can open and change that panel, so pick codes that are hard to guess (🎲). The server's own model (and its Gemini key) is only used for panels whose `server_llm` flag is on. Everything else runs in the visitor's browser or on their own key.

### Database

Neon Postgres from the Vercel Marketplace, which sets `DATABASE_URL` on the project (Preview and Production). For local dev, add `DATABASE_URL` to `.env.local`. Without it the server uses an in-memory store with the same behaviour, which loses its data on restart.

The table is created on first use (`lib/panels-db.ts`):

```sql
CREATE TABLE panels (
  server_llm boolean NOT NULL DEFAULT false, -- may the server run its model for this panel?
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

- **Server:** Gemini (`gemini-3.8-flash`) with the server's `GOOGLE_GENERATIVE_AI_API_KEY`. It's only available for panels whose `server_llm` flag is on. `openPanel` returns the flag with the code check, Settings disables the option when it's off, and the server refuses otherwise. New panels get the flag from `SERVER_LLM_DEFAULT` (`true` or `false`, default `false`). Switch one panel with `UPDATE panels SET server_llm = true WHERE code = 'ABCD1234';`.
- **Gemini / OpenAI / Anthropic with your own key:** the key and model name are stored in this browser's `localStorage`. Requests go **straight from the browser to the provider** (`lib/browser-llm.ts`; Anthropic gets its `anthropic-dangerous-direct-browser-access` header), and only the resulting page is sent to the server to store. The key never reaches the server. For `fetchData`, the server only downloads the page (`fetchPageText`), because browsers can't read other sites, and the extraction runs in the browser with your key.
- **In this browser:** Chrome's built-in Gemini Nano via the [Prompt API](https://developer.chrome.com/docs/ai/prompt-api). It needs a recent desktop Chrome, and Chrome downloads the model (a few GB) on first use. The model runs in the page with a short prompt of its own (`lib/local-model.ts`), because its context window is about 9k tokens and it handles neither tools nor long JSON well. It returns the whole new document as plain HTML. Before saving, inline `<script>`s are moved to the end of `<body>`, because Nano often puts them in `<head>`, where they run before the page exists. A reply cut off before `</html>` is closed rather than rejected. **Experimental and very inaccurate:** expect simple, often wrong or half-finished pages; use a remote model for anything that matters. The Settings dialog says so too.

## Agents: Classic and Structured

Two agents can edit a panel, chosen per panel in Settings → Agent:

- **Classic:** the page is one HTML document, changed with `set_html` (rewrite) and `edit_html` (find/replace), with design notes in a comment at the top (`lib/genui.ts`). Every panel made before the Structured agent uses it, unchanged.
- **Structured** (the default for new panels): the page is kept as three JSON parts (`lib/structured.ts`):
  - `instructions`: purpose, layout, style, components, behavior, data. These replace the design notes.
  - `style`: `tokens` (CSS custom properties, rendered into `:root`), `rules` (`{selector: {property: value}}`, nested for `@media` and `@keyframes`) and an optional raw `css` string.
  - `structure`: `title`, `lang`, `head` nodes, `bodyAttrs`, `body` (a tree of `{tag, id, class, attrs, text, children}` nodes, or `{html}` for raw markup) and `scripts` (inline code, or `{src}`), which run at the end of `<body>`.

  The agent edits them with **`read_file(path?)`** and **`write_file(path?, content)`**, plus `web_search` and `fetch_url`. A path is `/`-separated keys and array indexes: `style/tokens/--accent`, `structure/body/0/children/2`. `-` as the last segment appends, `~1` stands for a `/` inside a key, and an empty path means all three parts. `content` is JSON, or plain text for a string. **Empty content deletes the path.** A write that would break the shape is refused with the reason and nothing is written: content that starts with `{` or `[` but isn't valid JSON, or a part of the wrong type. Two mistakes are fixed instead: an HTML string given for `body` or `head` becomes one raw node, and a single node becomes a list. `done(message)` ends the turn with the reply to the user.

To keep it fast (each model call costs a few seconds, however small), the prompt asks for every write of a change and `done` in one reply. The loop stops at `done`, so no call is spent on the closing sentence. Pages under 6k characters go into the prompt whole. Larger ones send an outline instead: instructions and tokens in full, each CSS selector with the properties it sets, the body tree with paths, ids, classes and short text, and the start of each script. The agent then reads only the values it changes, in one reply. Measured before this change on a 25k-character page with Gemini 3.8 Flash and your own key: "make the title green" took 5 model calls and 17.7 s (one re-read, three single writes, one call for the sentence), and a new 3x2 grid took about 105 s.

A Structured page is rendered to HTML (`renderParts`) and shown in the same sandboxed iframe, so `askLLM`, `fetchData`, saved state, Versions and Export work the same. The server renders the HTML itself from the parts it receives. The record keeps `html` (the rendered page) next to `agent: "structured"` and `parts`, and Classic records don't have those two fields.

**Switching agents** converts the page once and saves it as a new version, so Versions can undo it:
- Classic → Structured: `<style>` blocks go to `style.css`, the body to one raw node, scripts in order to `scripts`, and the design notes to `instructions`.
- Structured → Classic: the page keeps its rendered HTML, which carries the instructions as design notes.

Gemini Nano always writes plain HTML, so on a Structured panel its page is stored converted the same way. Imports take the open panel's agent.

## Saved state

Generated pages can keep their own data on the server, per panel, so it survives reloads and follows the panel to other devices (tasks, calendars, stats…). Injected into every page, each returning a Promise:

| Call | Resolves to |
| --- | --- |
| `saveState(key, value)` | `{key, value, date}`. `value` is any JSON value up to 100 KB |
| `loadState(key)` | `{key, value, date}`, or `null` if it was never saved |
| `listState(prefix?)` | `[{key, date}]` |
| `deleteState(key)` | `true` if the key existed |

`date` is the time of the last save (ISO). The page posts to the parent, which calls the `panelState` server action (`app/actions.ts`, 300 calls per minute per browser). That stores rows in `panel_state` (`panel_id`, `key`, `value jsonb`, `updated_at`, primary key `(panel_id, key)`, cascades when the panel is deleted), with at most 500 keys per panel and keys of up to 200 characters. The table is created on first use. The agent's prompt tells it to load state on page load, save after each change (debounced), and name the keys in the design notes' Data line. A panel has to be saved (its first change made) before its page can save state.

## Design notes

Every generated page starts with a `<!-- DESIGN NOTES … -->` comment: Purpose, Layout, Style (exact hex colors and fonts), Components, Behavior and Data. The prompt (`lib/genui.ts`) tells the model to read the notes before each change, to keep new and changed parts consistent with them, and to update them in the same edit when layout, style, behavior or data change. Pages without notes get them on their next change. Gemini Nano's short prompt asks for the same in one line.

## Agent tools

Requests to the server's model and to your own key run as an agent: a loop of up to 12 model steps (`MAX_AGENT_STEPS`) that can call these tools (`lib/genui.ts`, `lib/structured.ts`):
- **`set_html` / `edit_html`** (Classic) or **`read_file` / `write_file`** (Structured; see [Agents](#agents-classic-and-structured)): change the page.
- **`web_search(query)`:** a separate call to the same model with the provider's own search tool (`lib/web-search.ts`): Google Search grounding for Gemini, OpenAI's and Anthropic's web search. Returns a short answer and source URLs.
- **`fetch_url(url)`:** the text of a public page, from the server's address-checked fetcher (`lib/crawl.ts`, cached for 5 minutes). From the browser it goes through the `fetchPageText` server action, since browsers can't read other sites.

On the server, each research step is logged as `agent <CODE> web_search|fetch_url: …`. In the browser, the message box shows "searching the web for …" / "reading example.com…". Gemini Nano in the browser has no tool calling, so it stays single-shot.

## Progress and panel info

There is no status bar. While a request runs, the message box shows what is happening: the model and where it runs ("Asking Gemini … (your key, from this browser)…"), research steps ("searching the web for …", "reading example.com…"), and the Gemini Nano download progress. Settings shows the panel code and version (and "offline" when the server can't be reached), with a **Home** button.

## Export and import

Settings → Panel:
- **Export** downloads `aipanel-<CODE>-<date>.json`: `{"format": "aipanel", "version": 1, "exportedAt", "html", "requests", "code", "panelVersion"}`, plus `agent` and `parts` for a Structured page (`lib/panel-file.ts`).
- **Import** saves an export file, or a plain `.html` page (imported with no history), as the open panel's next version on the server.
- **Reset** (two clicks: "Reset page?") goes back to the empty welcome page, saved as a new version, so Versions can undo it. It lives here rather than next to the edit button, to keep it out of reach of a stray click.

## How it works

- `app/generative-ui.tsx` (client): `SpeechRecognition` transcribes speech. On end it calls the `submitRequest` server action and renders the returned HTML in a sandboxed `<iframe srcDoc>`.
- `lib/genui.ts`: the system prompt, prompt builder and document-editing tools, shared by both paths.
- `app/actions.ts` (server action): AI SDK `generateText` with the model from `lib/models.ts` (the server's Gemini by default, or the user's own provider and key) and two tools:
  - `set_html` replaces the whole document.
  - `edit_html` does an exact find/replace for small changes.

  The tools change the session's HTML in place, and the action returns the result. Generated pages use plain JavaScript for local interactions and call the injected `askLLM(request, context)` for anything that needs the model. `askLLM` only works from a click or key press (`navigator.userActivation`); calls on load, in timers or in loops are ignored, so a page can't regenerate itself in a loop.
- Live data: generated pages call the injected `fetchData(url, instruction)`, which the page can run on load and on a timer. The main page passes it to the `extractData` server action. `lib/crawl.ts` downloads the page (public http(s) hosts only, 10 s timeout, 3 MB cap) and reduces it to text with table rows kept. `lib/extract.ts` then has the selected model return JSON (`Output.json()`). The page renders that JSON itself. Results are cached for 5 minutes per URL + instruction, and each session gets 30 requests per 10 minutes. Sites that build their content with client-side JavaScript have no data in their HTML and won't work.
- `lib/panels-db.ts` (server): panels in Postgres; see [Database](#database). `openPanel(code, knownVersion)` checks a code and returns the panel (or `current` / `missing`) together with `serverLlm`. `savePanelContent` stores a page made in the browser (local model, your own key, Import, Reset) and creates the panel on its first change. `submitRequest(text, origin, code)` runs the server's model when the flag allows it. `revertPanel` restores an old version. `extractData` (server model) and `fetchPageText` (page text only) serve `fetchData`.
- `lib/panel-store.ts` (browser): the `localStorage` cache of server records. `cachePanel` only stores a copy whose version is newer than the cached one.
