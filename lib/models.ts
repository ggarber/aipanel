import "server-only";

import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { optionsFor, type Effort, type ProviderOptions } from "./model-factory";
import { SERVER_MODEL } from "./model-settings";

// The server's own model (GOOGLE_GENERATIVE_AI_API_KEY). User keys never reach the server:
// those requests run in the browser.
export function serverModel(effort: Effort = "normal"): { model: LanguageModel; providerOptions: ProviderOptions } {
  return { model: google(SERVER_MODEL), providerOptions: optionsFor("google", effort) };
}
