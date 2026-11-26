// web_search for the agent: one extra model call with only the provider's own search tool
// (Google Search grounding for Gemini, OpenAI's and Anthropic's web search). Kept separate
// from the main loop because providers don't all allow a built-in search tool alongside
// function tools. Shared by the server (its Gemini key) and the browser (the user's key).

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel, type ToolSet } from "ai";
import type { ProviderId } from "./model-settings";

export type SearchResult = { answer: string; sources: { title?: string; url: string }[] };

// apiKey undefined: the provider's env var (the server's GOOGLE_GENERATIVE_AI_API_KEY).
export type SearchModel = { provider: ProviderId; model: string; apiKey?: string };

const MAX_ANSWER_CHARS = 4000;
const MAX_SOURCES = 8;

function searchCall({ provider, model, apiKey }: SearchModel): { model: LanguageModel; tools: ToolSet } {
  switch (provider) {
    case "google": {
      const google = createGoogleGenerativeAI(apiKey ? { apiKey } : {});
      return { model: google(model), tools: { google_search: google.tools.googleSearch({}) } };
    }
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return { model: openai(model), tools: { web_search: openai.tools.webSearch({}) } };
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey, headers: { "anthropic-dangerous-direct-browser-access": "true" } });
      return { model: anthropic(model), tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 3 }) } };
    }
  }
}

export async function webSearch(model: SearchModel, query: string): Promise<SearchResult> {
  const { model: m, tools } = searchCall(model);
  const result = await generateText({
    model: m,
    tools,
    prompt:
      `Search the web and answer concisely with the facts found, including dates and numbers.\n` +
      `Query: ${query.slice(0, 500)}`,
    maxOutputTokens: 2000,
  });
  const sources: SearchResult["sources"] = [];
  for (const s of result.sources) {
    if (s.sourceType === "url" && !sources.some((x) => x.url === s.url)) sources.push({ title: s.title, url: s.url });
  }
  return { answer: result.text.slice(0, MAX_ANSWER_CHARS), sources: sources.slice(0, MAX_SOURCES) };
}
