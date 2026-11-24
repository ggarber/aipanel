// Turns page text into JSON with a model. Shared by the server (panels allowed to use the
// server's model) and the browser (the user's own key).

import { generateText, Output, type LanguageModel } from "ai";
import type { ProviderOptions } from "./model-factory";

const SYSTEM = `You extract data from the text of a web page. Follow the instruction and answer with
JSON only. Use numbers (not strings) for numeric values, with "." as the decimal separator.
Keep units and dates that the page states. If the page doesn't contain the data, answer
{"error": "<short reason>"}. Never invent values.`;

export async function extractJson(
  model: { model: LanguageModel; providerOptions: ProviderOptions },
  page: { url: string; text: string },
  instruction: string,
): Promise<unknown> {
  const { output } = await generateText({
    model: model.model,
    system: SYSTEM,
    prompt: `Instruction: ${instruction}\n\nPage URL: ${page.url}\nPage text:\n<page>\n${page.text}\n</page>`,
    output: Output.json(),
    maxOutputTokens: 16000,
    providerOptions: model.providerOptions,
  });
  return output;
}
