// Requests with the user's own key run here, straight from the browser to the provider:
// the key never reaches our server. Only the resulting page is sent there to be stored.

import { generateText, isStepCount } from "ai";
import { extractJson } from "./extract-core";
import { buildPrompt, buildTools, SYSTEM, type RequestOrigin } from "./genui";
import { createModel } from "./model-factory";
import type { RemoteModelChoice } from "./model-settings";

export async function runWithOwnKey(
  choice: RemoteModelChoice,
  doc: { html: string; requests: string[] },
  text: string,
  origin: RequestOrigin,
): Promise<{ html: string; message: string; changed: boolean }> {
  if (!choice.apiKey) throw new Error("Add your API key in Settings.");
  const work = { html: doc.html, requests: doc.requests };
  const { model, providerOptions } = createModel(choice);
  const result = await generateText({
    model,
    system: SYSTEM,
    prompt: buildPrompt(work, text, origin),
    tools: buildTools(work),
    stopWhen: isStepCount(8),
    maxOutputTokens: 32000,
    providerOptions,
  });
  return { html: work.html, message: result.text, changed: work.html !== doc.html };
}

const CACHE_MS = 5 * 60_000;
const extracts = new Map<string, { at: number; value: Promise<unknown> }>();

// fetchData with the user's own key: the server hands over the page text, this extracts.
export function extractWithOwnKey(
  choice: RemoteModelChoice,
  page: { url: string; text: string },
  instruction: string,
): { value: Promise<unknown>; hit: boolean } {
  const key = JSON.stringify([page.url, instruction, choice.provider, choice.model]);
  const entry = extracts.get(key);
  if (entry && Date.now() - entry.at < CACHE_MS) return { value: entry.value, hit: true };
  const value = extractJson(createModel(choice, "light"), page, instruction);
  extracts.set(key, { at: Date.now(), value });
  value.catch(() => extracts.delete(key));
  return { value, hit: false };
}
