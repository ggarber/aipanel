// Requests with the user's own key run here, straight from the browser to the provider:
// the key never reaches our server. Only the resulting page is sent there to be stored.

import { generateText, isStepCount } from "ai";
import { extractJson } from "./extract-core";
import { fetchPageText } from "@/app/actions";
import { buildPrompt, buildTools, MAX_AGENT_STEPS, SYSTEM, type AgentIO, type RequestOrigin } from "./genui";
import { webSearch } from "./web-search";
import { buildStructuredPrompt, buildStructuredTools, STRUCTURED_SYSTEM, type PageParts } from "./structured";
import { createModel } from "./model-factory";
import type { RemoteModelChoice } from "./model-settings";

export async function runWithOwnKey(
  choice: RemoteModelChoice,
  doc: { html: string; requests: string[] },
  text: string,
  origin: RequestOrigin,
  onTool?: AgentIO["onTool"],
): Promise<{ html: string; message: string; changed: boolean }> {
  if (!choice.apiKey) throw new Error("Add your API key in Settings.");
  const work = { html: doc.html, requests: doc.requests };
  const { model, providerOptions } = createModel(choice);
  const result = await generateText({
    model,
    system: SYSTEM,
    prompt: buildPrompt(work, text, origin),
    // The loop runs here: search goes from the browser to the provider with the user's key;
    // fetch_url asks our server for the page text (browsers can't read other sites).
    tools: buildTools(work, {
      search: (query) => webSearch(choice, query),
      fetch: async (url) => {
        const page = await fetchPageText(url);
        if (page.error || page.text === undefined || !page.url) throw new Error(page.error ?? "Couldn't read that page.");
        return { url: page.url, text: page.text };
      },
      onTool,
    }),
    stopWhen: isStepCount(MAX_AGENT_STEPS),
    maxOutputTokens: 32000,
    providerOptions,
  });
  return { html: work.html, message: result.text, changed: work.html !== doc.html };
}

// The Structured agent with the user's key: same loop, editing the three JSON parts.
export async function runStructuredWithOwnKey(
  choice: RemoteModelChoice,
  doc: { parts: PageParts; requests: string[] },
  text: string,
  origin: RequestOrigin,
  onTool?: AgentIO["onTool"],
): Promise<{ parts: PageParts; message: string; changed: boolean }> {
  if (!choice.apiKey) throw new Error("Add your API key in Settings.");
  const work = { parts: structuredClone(doc.parts), requests: doc.requests };
  const { model, providerOptions } = createModel(choice);
  const result = await generateText({
    model,
    system: STRUCTURED_SYSTEM,
    prompt: buildStructuredPrompt(work, text, origin),
    tools: buildStructuredTools(work, browserAgentIO(choice, onTool)),
    stopWhen: isStepCount(MAX_AGENT_STEPS),
    maxOutputTokens: 32000,
    providerOptions,
  });
  return { parts: work.parts, message: result.text, changed: JSON.stringify(work.parts) !== JSON.stringify(doc.parts) };
}

function browserAgentIO(choice: RemoteModelChoice, onTool?: AgentIO["onTool"]): AgentIO {
  return {
    search: (query) => webSearch(choice, query),
    fetch: async (url) => {
      const page = await fetchPageText(url);
      if (page.error || page.text === undefined || !page.url) throw new Error(page.error ?? "Couldn't read that page.");
      return { url: page.url, text: page.text };
    },
    onTool,
  };
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
