import "server-only";

import { generateText, Output } from "ai";
import { fetchPage } from "./crawl";
import { resolveModel } from "./models";
import type { RemoteModelChoice } from "./model-settings";

const CACHE_MS = 5 * 60_000;
const MAX_CACHE = 200;

type Extracted = { data: unknown; url: string; fetchedAt: string };

// Keyed by URL + instruction, so widgets refreshing on a timer don't refetch and re-run
// the model more than once per CACHE_MS. In-flight requests are shared too.
const globalForCache = globalThis as unknown as { extractCache?: Map<string, { at: number; value: Promise<Extracted> }> };
const cache = (globalForCache.extractCache ??= new Map());

const SYSTEM = `You extract data from the text of a web page. Follow the instruction and answer with
JSON only. Use numbers (not strings) for numeric values, with "." as the decimal separator.
Keep units and dates that the page states. If the page doesn't contain the data, answer
{"error": "<short reason>"}. Never invent values.`;

export function extractFromPage(url: string, instruction: string, choice: RemoteModelChoice | null): Promise<Extracted> {
  // The cache is shared, so it must not mix results from the server's model and a user's key.
  const key = JSON.stringify([url, instruction, choice ? `${choice.provider}:${choice.model}` : "server"]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const value = (async () => {
    const page = await fetchPage(url);
    const { model, providerOptions } = resolveModel(choice, "light");
    const { output } = await generateText({
      model,
      system: SYSTEM,
      prompt: `Instruction: ${instruction}\n\nPage URL: ${page.url}\nPage text:\n<page>\n${page.text}\n</page>`,
      output: Output.json(),
      maxOutputTokens: 16000,
      providerOptions,
    });
    return { data: output, url: page.url, fetchedAt: new Date().toISOString() };
  })();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return value;
}
