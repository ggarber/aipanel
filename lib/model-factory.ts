// Builds AI SDK models from a provider + model + key. Shared by the browser (requests with
// the user's own key go straight from the browser to the provider) and the server.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { generateText, LanguageModel } from "ai";
import type { ProviderId, RemoteModelChoice } from "./model-settings";

export type ProviderOptions = Parameters<typeof generateText>[0]["providerOptions"];

// "light" is for simple jobs such as pulling data out of a page, where thinking only adds latency.
export type Effort = "normal" | "light";

export function optionsFor(provider: ProviderId, effort: Effort): ProviderOptions {
  if (provider === "google") {
    return { google: { thinkingConfig: { thinkingLevel: effort === "light" ? "low" : "medium" } } };
  }
  return undefined;
}

export function createModel(
  choice: RemoteModelChoice,
  effort: Effort = "normal",
): { model: LanguageModel; providerOptions: ProviderOptions } {
  const { provider, model, apiKey } = choice;
  const providerOptions = optionsFor(provider, effort);
  switch (provider) {
    case "google":
      return { model: createGoogleGenerativeAI({ apiKey })(model), providerOptions };
    case "openai":
      return { model: createOpenAI({ apiKey })(model), providerOptions };
    case "anthropic":
      // Anthropic only answers browsers that opt in to direct access (the key is the user's own).
      return {
        model: createAnthropic({ apiKey, headers: { "anthropic-dangerous-direct-browser-access": "true" } })(model),
        providerOptions,
      };
  }
}
