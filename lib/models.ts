import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { isProviderId, type ProviderId, type RemoteModelChoice } from "./model-settings";

type ProviderOptions = Parameters<typeof import("ai").generateText>[0]["providerOptions"];

const SERVER_MODEL = "gemini-3.8-flash";

// Server actions take untrusted input, so check the shape before using it.
export function parseModelChoice(value: unknown): RemoteModelChoice | null {
  if (value === undefined || value === null) return null;
  const v = value as Partial<RemoteModelChoice>;
  if (!isProviderId(v.provider)) throw new Error("Unknown model provider.");
  const model = typeof v.model === "string" ? v.model.trim() : "";
  const apiKey = typeof v.apiKey === "string" ? v.apiKey.trim() : "";
  if (!model || model.length > 200) throw new Error("Set a model name in Settings.");
  if (!apiKey) throw new Error("Add your API key in Settings.");
  if (apiKey.length > 1000) throw new Error("That API key looks wrong.");
  return { provider: v.provider, model, apiKey };
}

// "light" is for simple jobs such as pulling data out of a page, where thinking only adds latency.
type Effort = "normal" | "light";

function optionsFor(provider: ProviderId, effort: Effort): ProviderOptions {
  if (provider === "google") {
    return { google: { thinkingConfig: { thinkingLevel: effort === "light" ? "low" : "medium" } } };
  }
  return undefined;
}

export function resolveModel(choice: RemoteModelChoice | null, effort: Effort = "normal"): {
  model: LanguageModel;
  providerOptions: ProviderOptions;
} {
  if (!choice) {
    // Reads GOOGLE_GENERATIVE_AI_API_KEY.
    return { model: google(SERVER_MODEL), providerOptions: optionsFor("google", effort) };
  }
  const { provider, model, apiKey } = choice;
  switch (provider) {
    case "google":
      return { model: createGoogleGenerativeAI({ apiKey })(model), providerOptions: optionsFor(provider, effort) };
    case "openai":
      return { model: createOpenAI({ apiKey })(model), providerOptions: optionsFor(provider, effort) };
    case "anthropic":
      return { model: createAnthropic({ apiKey })(model), providerOptions: optionsFor(provider, effort) };
  }
}
