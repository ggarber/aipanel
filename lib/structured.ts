import { tool } from "ai";
import { z } from "zod";
import { describeRequest, researchTools, type AgentIO, type RequestOrigin } from "./genui";

// The Structured agent: a page is kept as three JSON parts instead of one HTML document.
//   instructions  what the page is for and how it was built (the "design notes")
//   style         CSS as data: tokens (custom properties), rules by selector, raw css
//   structure     title, head extras, the body as a tree of element nodes, and scripts
// The agent edits them with read_file / write_file on "/"-separated paths. The page shown is
// render(parts): plain HTML, so it runs in the same sandboxed iframe with the same bridge.
// Shared by the server action and the browser (own key), like lib/genui.ts.

export type PanelAgent = "classic" | "structured";
export const DEFAULT_AGENT: PanelAgent = "structured";
export const AGENT_LABELS: Record<PanelAgent, string> = { classic: "Classic", structured: "Structured" };

export type PageNode =
  | { html: string } // raw HTML, the escape hatch (and what converted pages start as)
  | {
      tag: string;
      id?: string;
      class?: string;
      attrs?: Record<string, string | number | boolean>;
      text?: string;
      children?: PageNode[];
    };

export type PageScript = string | { src?: string; type?: string; code?: string };

export type PageParts = {
  instructions: Record<string, unknown>;
  style: {
    tokens?: Record<string, string | number>;
    rules?: Record<string, Record<string, unknown>>;
    css?: string;
  };
  structure: {
    title?: string;
    lang?: string;
    head?: PageNode[];
    bodyAttrs?: Record<string, string>;
    body?: PageNode[];
    scripts?: PageScript[];
  };
};

export const PART_NAMES = ["instructions", "style", "structure"] as const;
export const MAX_PARTS_CHARS = 400_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Coerces anything (an agent's write, a client's save) into the three-part shape.
export function normalizeParts(value: unknown): PageParts {
  const v = isObject(value) ? value : {};
  const style = isObject(v.style) ? v.style : {};
  const structure = isObject(v.structure) ? v.structure : {};
  return {
    instructions: isObject(v.instructions) ? v.instructions : {},
    style: {
      ...style,
      tokens: isObject(style.tokens) ? (style.tokens as Record<string, string>) : {},
      rules: isObject(style.rules) ? (style.rules as Record<string, Record<string, unknown>>) : {},
      css: typeof style.css === "string" ? style.css : "",
    },
    structure: {
      ...structure,
      title: typeof structure.title === "string" ? structure.title : "",
      head: Array.isArray(structure.head) ? (structure.head as PageNode[]) : [],
      body: Array.isArray(structure.body) ? (structure.body as PageNode[]) : [],
      scripts: Array.isArray(structure.scripts) ? (structure.scripts as PageScript[]) : [],
    },
  };
}

// ---------------------------------------------------------------------------------------
// Rendering

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TAG = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const ATTR = /^[^\s"'<>\/=]+$/;

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function renderAttrs(attrs: Record<string, unknown>): string {
  let out = "";
  for (const [name, value] of Object.entries(attrs)) {
    if (!ATTR.test(name) || value === false || value === null || value === undefined) continue;
    out += value === true ? ` ${name}` : ` ${name}="${escapeAttr(String(value))}"`;
  }
  return out;
}

function renderNode(node: unknown, depth = 0): string {
  if (typeof node === "string") return escapeText(node);
  if (!isObject(node) || depth > 64) return "";
  if (typeof node.html === "string") return node.html;
  const tag = typeof node.tag === "string" && TAG.test(node.tag) ? node.tag : "";
  if (!tag) return "";
  const attrs: Record<string, unknown> = {};
  if (node.id !== undefined) attrs.id = node.id;
  if (node.class !== undefined) attrs.class = node.class;
  if (isObject(node.attrs)) Object.assign(attrs, node.attrs);
  const open = `<${tag}${renderAttrs(attrs)}>`;
  if (VOID_TAGS.has(tag.toLowerCase())) return open;
  const text = typeof node.text === "string" || typeof node.text === "number" ? escapeText(String(node.text)) : "";
  const children = Array.isArray(node.children) ? node.children.map((c) => renderNode(c, depth + 1)).join("") : "";
  return `${open}${text}${children}</${tag}>`;
}

function renderDeclarations(decls: Record<string, unknown>, indent: string): string {
  let out = "";
  for (const [key, value] of Object.entries(decls)) {
    if (isObject(value)) out += `${indent}${key} {\n${renderDeclarations(value, indent + "  ")}${indent}}\n`;
    else if (value !== null && value !== undefined && value !== "") out += `${indent}${key}: ${value};\n`;
  }
  return out;
}

export function renderCss(style: PageParts["style"]): string {
  let css = "";
  const tokens = Object.entries(style.tokens ?? {});
  if (tokens.length) {
    css += `:root {\n${tokens.map(([k, v]) => `  ${k.startsWith("--") ? k : `--${k}`}: ${v};`).join("\n")}\n}\n`;
  }
  // A rule whose values are objects is a block of rules: @media, @keyframes, @supports.
  for (const [selector, decls] of Object.entries(style.rules ?? {})) {
    if (isObject(decls)) css += `${selector} {\n${renderDeclarations(decls, "  ")}}\n`;
  }
  if (style.css) css += style.css.trim() + "\n";
  return css;
}

function renderScript(script: PageScript): string {
  const safe = (code: string) => code.replace(/<\/script/gi, "<\\/script");
  if (typeof script === "string") return `<script>\n${safe(script)}\n</script>`;
  if (!isObject(script)) return "";
  const attrs = renderAttrs({ type: script.type, src: script.src });
  return `<script${attrs}>${typeof script.code === "string" ? `\n${safe(script.code)}\n` : ""}</script>`;
}

// The instructions, as the classic agent's design notes comment, so a page converted back
// to Classic keeps them.
function renderNotes(instructions: Record<string, unknown>): string {
  const lines = Object.entries(instructions)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (!lines.length) return "";
  return `<!-- DESIGN NOTES\n${lines.join("\n").replace(/-->/g, "--&gt;")}\n-->\n`;
}

export function renderParts(input: PageParts): string {
  const p = normalizeParts(input);
  const s = p.structure;
  const lang = typeof s.lang === "string" && /^[a-zA-Z-]{2,20}$/.test(s.lang) ? ` lang="${s.lang}"` : "";
  return (
    `<!doctype html>\n${renderNotes(p.instructions)}<html${lang}>\n<head>\n` +
    `<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    (s.title ? `<title>${escapeText(s.title)}</title>\n` : "") +
    (s.head ?? []).map((n) => renderNode(n)).join("\n") +
    `\n<style>\n${renderCss(p.style)}</style>\n</head>\n` +
    `<body${renderAttrs(isObject(s.bodyAttrs) ? s.bodyAttrs : {})}>\n` +
    (s.body ?? []).map((n) => renderNode(n)).join("\n") +
    "\n" +
    (s.scripts ?? []).map(renderScript).join("\n") +
    `\n</body>\n</html>\n`
  );
}

// ---------------------------------------------------------------------------------------
// Converting a classic HTML page (switching agents, Gemini Nano's output, plain imports)

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

function parseNotes(comment: string): Record<string, unknown> {
  const notes: Record<string, string> = {};
  let key = "";
  for (const line of comment.split("\n")) {
    const m = /^\s*([A-Za-z][A-Za-z ]{0,30}):\s*(.*)$/.exec(line);
    if (m) {
      key = m[1].trim().toLowerCase().replace(/\s+/g, "_");
      notes[key] = m[2].trim();
    } else if (key && line.trim()) notes[key] += " " + line.trim();
  }
  return notes;
}

export function partsFromHtml(html: string): PageParts {
  let rest = html;
  let instructions: Record<string, unknown> = {};
  rest = rest.replace(/<!--\s*DESIGN NOTES([\s\S]*?)-->\s*/i, (_, body: string) => {
    instructions = parseNotes(body.replace(/--&gt;/g, "-->"));
    return "";
  });
  const css: string[] = [];
  rest = rest.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, body: string) => {
    css.push(body.trim());
    return "";
  });
  const scripts: PageScript[] = [];
  rest = rest.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrSource: string, body: string) => {
    const attrs = parseAttrs(attrSource);
    const code = body.trim();
    if (!attrs.src && (!attrs.type || /javascript/i.test(attrs.type))) {
      if (code) scripts.push(code);
    } else scripts.push({ ...(attrs.src && { src: attrs.src }), ...(attrs.type && { type: attrs.type }), ...(code && { code }) });
    return "";
  });
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(rest)?.[1].trim() ?? "";
  const lang = parseAttrs(/<html([^>]*)>/i.exec(rest)?.[1] ?? "").lang;
  const headSource = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(rest)?.[1] ?? "";
  const head: PageNode[] = [...headSource.matchAll(/<link[^>]*>/gi)].map((m) => ({ html: m[0] }));
  const bodyMatch = /<body([^>]*)>([\s\S]*?)(?:<\/body>|$)/i.exec(rest);
  const bodyInner = bodyMatch
    ? bodyMatch[2]
    : rest.replace(/<!doctype[^>]*>/i, "").replace(/<head[^>]*>[\s\S]*?<\/head>/i, "").replace(/<\/?html[^>]*>/gi, "");
  const bodyAttrs = bodyMatch ? parseAttrs(bodyMatch[1]) : {};
  const body = bodyInner.trim();
  return {
    instructions: Object.keys(instructions).length ? instructions : { purpose: title || "" },
    style: { tokens: {}, rules: {}, css: css.join("\n\n") },
    structure: {
      title,
      ...(lang && { lang }),
      head,
      ...(Object.keys(bodyAttrs).length && { bodyAttrs }),
      body: body ? [{ html: body }] : [],
      scripts,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Paths: "/"-separated keys and array indexes, e.g. style/tokens/--accent or
// structure/body/0/children/2. "~1" stands for "/" and "~0" for "~" inside a key; "-" as
// the last segment of an array path appends. An empty path is all three parts.

export function parsePath(path: string | undefined | null): string[] {
  const p = (path ?? "").trim().replace(/^\/+|\/+$/g, "");
  return p ? p.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~")) : [];
}

function getAt(root: unknown, segments: string[]): { found: true; value: unknown } | { found: false; error: string } {
  let node = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (Array.isArray(node) && /^\d+$/.test(seg) && Number(seg) < node.length) node = node[Number(seg)];
    else if (isObject(node) && Object.hasOwn(node, seg)) node = node[seg];
    else {
      const at = segments.slice(0, i).join("/") || "(root)";
      const has = Array.isArray(node)
        ? `an array of ${node.length} (indexes 0–${node.length - 1})`
        : isObject(node)
          ? `keys: ${Object.keys(node).slice(0, 40).join(", ") || "none"}`
          : "a value with nothing inside";
      return { found: false, error: `"${seg}" not found under ${at}, which has ${has}.` };
    }
  }
  return { found: true, value: node };
}

// Sets (value !== undefined) or deletes (undefined) at the path, creating missing objects.
function setAt(root: Record<string, unknown>, segments: string[], value: unknown): string | null {
  let node: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(seg) || Number(seg) >= node.length) return `No index ${seg} in the array at ${segments.slice(0, i).join("/")}.`;
      node = node[Number(seg)];
    } else if (isObject(node)) {
      if (!isObject(node[seg]) && !Array.isArray(node[seg])) {
        if (value === undefined) return null; // deleting something that isn't there
        node[seg] = {};
      }
      node = node[seg];
    } else return `${segments.slice(0, i).join("/")} isn't an object or array.`;
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(node)) {
    if (last === "-") {
      if (value === undefined) return `Use an index to delete from ${segments.slice(0, -1).join("/")}.`;
      node.push(value);
      return null;
    }
    if (!/^\d+$/.test(last) || Number(last) > node.length) {
      return `Use an index 0–${node.length - 1} or "-" to append in ${segments.slice(0, -1).join("/")}.`;
    }
    if (value === undefined) node.splice(Number(last), 1);
    else node[Number(last)] = value;
    return null;
  }
  if (!isObject(node)) return `${segments.slice(0, -1).join("/")} isn't an object or array.`;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return null;
}

const MAX_READ_CHARS = 40_000;

// What read_file returns for a value too large to send whole: its children with their sizes.
function shallow(value: unknown): unknown {
  const size = (v: unknown) => JSON.stringify(v)?.length ?? 0;
  if (Array.isArray(value)) return value.map((v, i) => ({ index: i, chars: size(v), ...summaryOf(v) }));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, { chars: size(v), ...summaryOf(v) }]));
  return String(value).slice(0, MAX_READ_CHARS);
}

function summaryOf(v: unknown): Record<string, unknown> {
  if (!isObject(v)) return {};
  return Object.fromEntries(["tag", "id", "class"].filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));
}

export function readPart(parts: PageParts, path?: string | null): unknown {
  const got = getAt(parts, parsePath(path));
  if (!got.found) return { error: got.error };
  const json = JSON.stringify(got.value) ?? "null";
  if (json.length <= MAX_READ_CHARS) return { path: path ?? "", value: got.value };
  return {
    path: path ?? "",
    truncated: `Too large to return whole (${json.length} chars). Read the children by path:`,
    children: shallow(got.value),
  };
}

// The shape every part must keep. A write that breaks it is refused with the reason, rather
// than normalizeParts silently dropping it (e.g. a body that arrived as one string).
const ARRAY_FIELDS: Record<string, string> = {
  "structure/body": "an array of nodes",
  "structure/head": "an array of nodes",
  "structure/scripts": "an array of script strings",
};
const OBJECT_FIELDS: Record<string, string> = {
  instructions: "an object of short strings",
  style: "an object {tokens, rules, css}",
  structure: "an object {title, head, body, scripts}",
  "style/tokens": 'an object {"--name": value}',
  "style/rules": "an object {selector: {property: value}}",
};

// Fixes the forgivable mistakes (an HTML string where nodes go, one node instead of a list)
// and returns an error for the rest.
function checkShape(root: Record<string, unknown>): string | null {
  for (const [path, want] of Object.entries(OBJECT_FIELDS)) {
    const got = getAt(root, parsePath(path));
    if (got.found && !isObject(got.value)) return `${path} must be ${want}; got ${typeOf(got.value)}.`;
  }
  const style = root.style as Record<string, unknown> | undefined;
  if (style && style.css !== undefined && typeof style.css !== "string") return "style/css must be a string of CSS.";
  const structure = root.structure as Record<string, unknown> | undefined;
  if (!structure) return null;
  for (const [path, want] of Object.entries(ARRAY_FIELDS)) {
    const key = path.split("/")[1];
    const value = structure[key];
    if (value === undefined || Array.isArray(value)) continue;
    if (key === "scripts" && (typeof value === "string" || isObject(value))) structure[key] = [value];
    else if (key !== "scripts" && typeof value === "string") structure[key] = [{ html: value }];
    else if (key !== "scripts" && isObject(value) && (typeof value.tag === "string" || typeof value.html === "string")) {
      structure[key] = [value];
    } else return `${path} must be ${want}; got ${typeOf(value)}.`;
  }
  return null;
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (v === null) return "null";
  if (typeof v === "string") return `a string (${v.length} chars${/^\s*[[{]/.test(v) ? ", which is not valid JSON" : ""})`;
  return typeof v === "object" ? "an object" : `a ${typeof v}`;
}

// content "" (or only spaces) deletes; otherwise JSON, or plain text for a string value.
// Content that starts like JSON ({ or [) must parse: guessing it was meant as text would store
// a broken page.
export function writePart(work: { parts: PageParts }, path: string | undefined | null, content: string) {
  const segments = parsePath(path);
  const remove = !content.trim();
  let value: unknown;
  if (!remove) {
    try {
      value = JSON.parse(content);
    } catch (err) {
      if (/^\s*[[{]/.test(content)) {
        return {
          ok: false,
          error:
            `content is not valid JSON (${err instanceof Error ? err.message : "parse error"}). Nothing was written. ` +
            "Check the quotes and escapes, or write smaller pieces (one node or one rule per call).",
        };
      }
      value = content;
    }
  }
  if (segments.length === 0) {
    if (remove) return { ok: false, error: "Can't delete the whole page; write the parts instead." };
    if (!isObject(value)) return { ok: false, error: "The whole page is a JSON object {instructions, style, structure}." };
  } else if (!(PART_NAMES as readonly string[]).includes(segments[0])) {
    return { ok: false, error: `Paths start with ${PART_NAMES.join(", ")}.` };
  }
  let next: Record<string, unknown>;
  if (segments.length === 0) next = structuredClone(value) as Record<string, unknown>;
  else {
    next = structuredClone(work.parts) as unknown as Record<string, unknown>;
    if (segments.length === 1) {
      if (remove) next[segments[0]] = {};
      else if (!isObject(value)) return { ok: false, error: `${segments[0]} must be a JSON object; got ${typeOf(value)}.` };
      else next[segments[0]] = value;
    } else {
      const error = setAt(next, segments, remove ? undefined : value);
      if (error) return { ok: false, error };
    }
  }
  const shapeError = checkShape(next);
  if (shapeError) return { ok: false, error: `${shapeError} Nothing was written.` };
  const normalized = normalizeParts(next);
  const chars = JSON.stringify(normalized).length;
  if (chars > MAX_PARTS_CHARS) return { ok: false, error: "That would make the page too large." };
  work.parts = normalized;
  if (remove) return { ok: true, deleted: path, chars };
  if (segments[segments.length - 1] === "-") {
    const list = getAt(normalized, segments.slice(0, -1));
    segments[segments.length - 1] = String(list.found && Array.isArray(list.value) ? list.value.length - 1 : 0);
  }
  const stored = getAt(normalized, segments);
  return { ok: true, chars, stored: stored.found ? typeOf(stored.value) : "nothing" };
}

// Tools edit work.parts in place; io adds the research tools.
export function buildStructuredTools(work: { parts: PageParts }, io: AgentIO = {}) {
  return {
    ...researchTools(io),
    read_file: tool({
      description:
        "Read a part of the page as JSON. path: e.g. 'instructions', 'style/rules', 'structure/body/0/children/1'; omit it for all three parts.",
      inputSchema: z.object({
        path: z.string().optional().describe("'/'-separated path into the page; omit for everything."),
      }),
      execute: async ({ path }) => readPart(work.parts, path),
    }),
    write_file: tool({
      description:
        "Write a value at a path of the page, replacing what is there. content is JSON (an object, array, number, or a quoted string), or plain text for a string value. Empty content deletes the path (an array item is removed). A last segment of '-' appends to an array. Omit path to replace all three parts at once.",
      inputSchema: z.object({
        path: z.string().optional().describe("'/'-separated path, e.g. 'style/tokens/--accent' or 'structure/body/-'."),
        content: z.string().describe("The new value as JSON (or plain text for a string). Empty deletes."),
      }),
      execute: async ({ path, content }) => writePart(work, path, content),
    }),
  };
}

// ---------------------------------------------------------------------------------------
// Prompt

export const STRUCTURED_SYSTEM = `You are the engine of a voice-driven generative UI. The user speaks a request; you get
the transcript and the page currently on screen, and you change the page to satisfy it.

The page is stored as three JSON parts, and the screen shows them rendered to HTML:
1. instructions: the page's memory of what it is and how it was built. Keys:
   purpose (one line), layout (structure and sections), style (palette, fonts, sizes, mood in
   words), components (the reusable pieces and how they look), behavior (interactions, scripts,
   askLLM/fetchData and their refresh), data (where content came from with dates, what is live,
   saved-state keys). Short strings; about the page as it is now, not a changelog.
2. style: CSS as data.
   - tokens: CSS custom properties, rendered into :root, e.g. {"--bg": "#0b1020", "--accent": "#ffcc00",
     "--radius": "14px", "--font": "Inter, system-ui, sans-serif"}. Put every color, font, radius
     and shadow the page uses here and refer to them with var(--name) everywhere else.
   - rules: {selector: {property: value}}, e.g. {".card": {"background": "var(--panel)",
     "border-radius": "var(--radius)"}}. Nest for at-rules: {"@media (max-width: 600px)":
     {".grid": {"grid-template-columns": "1fr"}}}, {"@keyframes pop": {"from": {"opacity": 0}}}.
   - css: optional raw CSS string for anything awkward as data. Prefer tokens + rules.
3. structure: the document.
   - title: the page title. lang: optional. head: extra nodes for <head> (e.g. a font <link>).
   - bodyAttrs: optional attributes of <body>.
   - body: an array of nodes. A node is {"tag": "div", "id"?: "...", "class"?: "...",
     "attrs"?: {"name": "value"}, "text"?: "escaped text", "children"?: [nodes]}. Text comes before
     children. {"html": "<raw html>"} is an escape hatch for markup that is awkward as nodes
     (e.g. a large inline SVG); pages converted from HTML start as one raw node, which you may
     split into proper nodes when you change them.
   - scripts: an array of inline JavaScript strings, run in order at the end of <body> (after
     the elements exist). An item can also be {"src": "https://cdn.jsdelivr.net/..."}.
     Give elements that scripts use an id.

Tools:
- read_file(path?): returns the JSON at a path. Omit path for all three parts.
- write_file(path?, content): writes the value at the path (content is JSON, or plain text for
  a string). Empty content deletes the path. "-" as the last segment appends to an array.
  Omit path to replace the whole page with {"instructions", "style", "structure"}.
- Paths are "/"-separated keys and array indexes: "instructions/purpose", "style/tokens/--accent",
  "style/rules/.card", "structure/body/2/children/0/text", "structure/scripts/1",
  "structure/body/-". Inside a key, write "/" as "~1" (e.g. a selector with a "/").
- Edit the smallest path that does the job: change one token to recolor, one rule to restyle,
  one node to change some content, append a node to add a section. Write a whole part (or the
  whole page) only for a new screen or a substantial redesign.
- Array indexes shift after a delete or insert: re-read the parent before further index edits.
- Check every write_file result. ok: false means nothing was written: fix the content (usually
  JSON quoting or escaping) and write again. Never finish while structure/body is empty or
  scripts refer to element ids that aren't in the body.
- For a new screen, write it in a few calls rather than one huge JSON: instructions, then
  style, then structure (or the body section by section with "structure/body/-"), then scripts.
- When the page is large, the prompt shows an outline; read_file the parts you need first.

You work as an agent: you can call tools several times before answering. Research tools (when
they are available):
- web_search(query): searches the web and returns a short answer with source URLs. Use it when
  the request needs facts you're not sure of or recent information (news, prices, schedules,
  people, events). Search first, then build the page.
- fetch_url(url): returns the text of a web page. Use it to read a page the user names or a
  source from web_search.
Put what you learn into the page (with the source and the date you looked it up). For data that
must keep refreshing while the page is open, use fetchData in the page instead (see below).

Keep the instructions true and follow them:
- Before any change, read the instructions and follow them, so new and changed parts match the
  existing layout and style (same tokens, fonts, spacing and component styles) unless the user
  asks to change them.
- Whenever a change affects layout, style, components, behavior or data, update the matching
  instructions keys in the same turn. If they are missing or thin, fill them in.

Rules for the page:
- It renders in a sandboxed iframe that fills the viewport. Scripts run; there is no network
  access to your server, no cookies, no localStorage guarantee, and no parent-page access.
- External resources only from https://cdn.jsdelivr.net or https://unpkg.com if truly needed.
- Make it look polished and modern, responsive, and readable. Keep the bottom-right corner
  (about 96x96px) free of important content — a floating edit button sits there.
- Transcripts come from speech recognition and may have errors; infer the intent.

Interactivity — pick the cheapest mechanism that works:
- Plain JavaScript in structure.scripts for anything computable in the page: counters, toggles,
  tabs, filters, sorting, form validation, timers, small calculations. No round trip to you.
- askLLM(request, context) is a global function already defined in the page. Calling it sends
  the request back to you as a new turn, and you update the page again. Use it only when the
  action needs knowledge, generation, or a new/changed screen, e.g. a "More about the weather
  in Paris" button, "Generate 5 more ideas", "Show details for this item".
  - request: a short plain-language instruction, written as if the user had said it.
  - context: an optional JSON-serializable object with the state the request depends on
    (form values, the selected item, the current counter value…).
  - Runtime changes made by scripts are NOT kept: each update starts from the parts you wrote.
    Pass any runtime state you need to preserve in context, and write it into the parts.
  - Only call askLLM from a user action (click, submit) — never on load, in timers, or in loops.
  - Disable the triggering control and show a loading state when calling it; the whole page is
    replaced when the response arrives.
Saved state — the page's own data, kept on the server for this panel, so it survives reloads
and follows the panel to other devices. Global functions in the page, each returns a Promise:
  - saveState(key, value): stores a JSON value (object, array, number…; up to 100 KB) under a
    short key such as "tasks", "events" or "stats". Resolves to {key, value, date}.
  - loadState(key): resolves to {key, value, date} (date = last save, ISO), or null if never saved.
  - listState(prefix?): resolves to [{key, date}] of the saved keys (optionally starting with prefix).
  - deleteState(key): removes a key; resolves to true if it existed.
  - Use it for anything the user creates or changes that should be there next time: tasks,
    calendar events, notes, scores, stats, settings, form drafts. Don't use localStorage for it.
  - On load: show the page, call loadState for each key, then render the saved data (fall back
    to defaults when it's null). After each change: update the page right away and call saveState
    with the whole new value (debounce rapid changes such as typing by ~500 ms).
  - Show errors from saveState briefly (e.g. "Not saved") and keep the change on screen.
  - It may run on load and after any change (unlike askLLM). Keep one key per kind of data.
  - Name the keys in instructions.data.

Live data from the web — fetchData(url, instruction) is also a global function in the page.
It returns a Promise of { data, url, fetchedAt }: the server downloads the page at url, and an
LLM extracts what the instruction asks for and returns it as JSON in data. It rejects with an
Error on failure.
  - Use it when the user names a site or asks for live information (prices, rates, schedules,
    scores). Spell out the exact JSON shape in the instruction, e.g. 'Return {"unit": string,
    "hours": [{"hour": "00-01", "price": number}]} with the price for every hour of today'.
  - Unlike askLLM it may run on load, and periodically with setInterval — at most every
    5 minutes (results are cached for 5 minutes anyway). Default to every 15 minutes.
  - Render data with plain JS: inline SVG charts or HTML tables (or Chart.js from
    https://cdn.jsdelivr.net if a real chart library is needed). Show a loading state, the
    error message on failure (keep the last good data), the source and "updated hh:mm".
  - Never put data you didn't get from fetchData in the page as if it were live.
- Without web_search, fetch_url or fetchData you have no live data. For real-time topics you
  couldn't look up, give general or typical information and label it as not live.

Always call write_file to change the screen unless the request is unclear or impossible; then
make no change and reply with one short sentence. After your tool calls, reply with one short
sentence describing what changed.`;

// The page goes into the prompt whole when it's small; otherwise instructions and style whole
// and an outline of the structure, and the agent reads what it needs.
const INLINE_PARTS_CHARS = 30_000;
const MAX_OUTLINE_LINES = 300;

function outline(parts: PageParts): string {
  const lines: string[] = [];
  const walk = (nodes: unknown, path: string, depth: number) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((n, i) => {
      if (lines.length >= MAX_OUTLINE_LINES) return;
      const p = `${path}/${i}`;
      const pad = "  ".repeat(depth);
      if (!isObject(n)) return;
      if (typeof n.html === "string") {
        lines.push(`${pad}${p}  raw html (${n.html.length} chars): ${n.html.slice(0, 80).replace(/\s+/g, " ")}…`);
        return;
      }
      const sel = `${n.tag}${n.id ? `#${n.id}` : ""}${n.class ? `.${String(n.class).trim().split(/\s+/).join(".")}` : ""}`;
      const text = typeof n.text === "string" ? ` "${n.text.slice(0, 60)}"` : "";
      lines.push(`${pad}${p}  <${sel}>${text}`);
      walk(n.children, `${p}/children`, depth + 1);
    });
  };
  walk(parts.structure.body, "structure/body", 0);
  if (lines.length >= MAX_OUTLINE_LINES) lines.push("… (more: read_file the parents)");
  const scripts = (parts.structure.scripts ?? []).map(
    (s, i) => `structure/scripts/${i}  ${typeof s === "string" ? `${s.length} chars: ${s.slice(0, 80).replace(/\s+/g, " ")}…` : JSON.stringify(s).slice(0, 120)}`,
  );
  return [
    `structure/title: ${JSON.stringify(parts.structure.title ?? "")}`,
    `structure/head: ${(parts.structure.head ?? []).length} nodes`,
    ...lines,
    ...scripts,
  ].join("\n");
}

export function buildStructuredPrompt(
  work: { parts: PageParts; requests: string[] },
  text: string,
  origin: RequestOrigin,
): string {
  const previous = work.requests.length
    ? `Earlier requests (oldest first):\n${work.requests.map((r) => `- ${r}`).join("\n")}\n\n`
    : "";
  const json = JSON.stringify(work.parts);
  const page =
    json.length <= INLINE_PARTS_CHARS
      ? `Current page (all three parts):\n<page>\n${json}\n</page>`
      : `Current page (large: instructions and style in full, then an outline of structure; read_file for details):\n` +
        `<instructions>\n${JSON.stringify(work.parts.instructions)}\n</instructions>\n` +
        `<style>\n${JSON.stringify(work.parts.style).slice(0, INLINE_PARTS_CHARS)}\n</style>\n` +
        `<structure_outline>\n${outline(work.parts)}\n</structure_outline>`;
  return `${previous}${page}\n\n${describeRequest(text, origin)}`;
}

// The welcome page a new Structured panel starts with (looks like the classic one).
export const INITIAL_PARTS: PageParts = {
  instructions: {
    purpose: "Welcome page of an empty panel: tells the user how to ask for a UI.",
    layout: "One centered card on a full-height background.",
    style: "Game-like: deep blue radial background with faint diagonal stripes, blue card with a dark navy border and drop shadow, gold outlined heading, light blue bold text.",
    components: "hint card (.hint) with an h1 and a paragraph; em for the example requests.",
    behavior: "None.",
    data: "None.",
  },
  style: {
    tokens: {
      "--navy": "#0e2257",
      "--gold": "#ffd84a",
      "--ink": "#2a1300",
      "--text": "#dbe7ff",
      "--highlight": "#ffe066",
      "--font": "system-ui, sans-serif",
    },
    rules: {
      body: {
        margin: "0",
        "min-height": "100vh",
        display: "grid",
        "place-items": "center",
        color: "#fff",
        "font-family": "var(--font)",
        background:
          "repeating-linear-gradient(135deg, rgb(255 255 255 / .035) 0 18px, transparent 18px 36px), radial-gradient(ellipse at 50% -10%, #3f8cff 0%, #1d4fbf 35%, #0b1d4a 75%)",
      },
      ".hint": {
        "text-align": "center",
        "max-width": "30rem",
        margin: "1.5rem",
        padding: "1.75rem 2rem",
        background: "linear-gradient(#2f6fe0, #1f4fb0)",
        border: "3px solid var(--navy)",
        "border-radius": "18px",
        "box-shadow": "inset 0 3px 0 rgb(255 255 255 / .25), 0 6px 0 var(--navy), 0 12px 24px rgb(0 0 0 / .35)",
      },
      h1: {
        margin: "0 0 .75rem",
        "font-size": "2rem",
        "font-weight": "900",
        "letter-spacing": ".02em",
        color: "var(--gold)",
        "-webkit-text-stroke": "2px var(--ink)",
        "paint-order": "stroke fill",
        "text-shadow": "0 4px 0 var(--ink)",
      },
      p: { margin: "0", "line-height": "1.5", "font-weight": "600", color: "var(--text)" },
      em: { "font-style": "normal", color: "var(--highlight)" },
    },
    css: "",
  },
  structure: {
    title: "",
    head: [],
    body: [
      {
        tag: "div",
        class: "hint",
        children: [
          { tag: "h1", text: "Say what you want to see" },
          {
            tag: "p",
            text: "Click the gold button in the bottom right (or hold it to talk) and describe a UI. Try ",
            children: [
              { tag: "em", text: "“a todo list for a camping trip”" },
              { html: " or " },
              { tag: "em", text: "“a dashboard with three KPI cards”" },
              { html: "." },
            ],
          },
        ],
      },
    ],
    scripts: [],
  },
};

export const INITIAL_STRUCTURED_HTML = renderParts(INITIAL_PARTS);

// A Structured change, checked and rendered: what gets stored.
export function structuredContent(value: unknown): { parts: PageParts; html: string } {
  const parts = normalizeParts(value);
  if (JSON.stringify(parts).length > MAX_PARTS_CHARS) throw new Error("The page is too large.");
  return { parts, html: renderParts(parts) };
}
