import "server-only";

import { fetchPage } from "./crawl";
import { extractJson } from "./extract-core";
import { serverModel } from "./models";

const CACHE_MS = 5 * 60_000;
const MAX_CACHE = 200;

type Cached<T> = Map<string, { at: number; value: Promise<T> }>;
const g = globalThis as unknown as {
  pageCache?: Cached<{ url: string; text: string }>;
  extractCache?: Cached<{ data: unknown; url: string; fetchedAt: string }>;
};
const pages = (g.pageCache ??= new Map());
const extracts = (g.extractCache ??= new Map());

// Shares results (and in-flight requests) for CACHE_MS, so widgets refreshing on a timer
// don't refetch the page or rerun the model.
function cached<T>(cache: Cached<T>, key: string, load: () => Promise<T>): { value: Promise<T>; hit: boolean } {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at < CACHE_MS) return { value: entry.value, hit: true };
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return { value, hit: false };
}

// The page as text, for the browser to extract from with the user's own model.
export function pageText(url: string) {
  return cached(pages, url, () => fetchPage(url));
}

// Fetch + extract with the server's model.
export function extractWithServer(url: string, instruction: string) {
  return cached(extracts, JSON.stringify([url, instruction]), async () => {
    const page = await pageText(url).value;
    const data = await extractJson(serverModel("light"), page, instruction);
    return { data, url: page.url, fetchedAt: new Date().toISOString() };
  });
}
