// Model settings chosen in the page and kept in this browser's localStorage.

export const PROVIDERS = {
  google: { label: "Gemini", defaultModel: "gemini-3.8-flash", keyUrl: "https://aistudio.google.com/apikey" },
  openai: { label: "OpenAI", defaultModel: "gpt-6.2-sol", keyUrl: "https://platform.openai.com/api-keys" },
  anthropic: { label: "Anthropic", defaultModel: "claude-sonnet-5-5", keyUrl: "https://console.anthropic.com/settings/keys" },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

// The model behind "Server default", using the server's GOOGLE_GENERATIVE_AI_API_KEY.
export const SERVER_MODEL = "gemini-3.8-flash";
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

// "server": the server's own Gemini key, as before. "local": Chrome's built-in model.
export type ModelSource = "server" | "local" | ProviderId;

export type ModelSettings = {
  source: ModelSource;
  keys: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
};

// What the browser sends with a request when the user picked their own key.
export type RemoteModelChoice = { provider: ProviderId; model: string; apiKey: string };

export const DEFAULT_SETTINGS: ModelSettings = { source: "server", keys: {}, models: {} };

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && value in PROVIDERS;
}

export function modelFor(settings: ModelSettings, provider: ProviderId): string {
  return settings.models[provider]?.trim() || PROVIDERS[provider].defaultModel;
}

// Human-readable model + where it runs, for the status line.
export function describeModel(settings: ModelSettings): string {
  const { source } = settings;
  if (source === "server") return `Gemini ${SERVER_MODEL} (server)`;
  if (source === "local") return "Gemini Nano (in this browser)";
  return `${PROVIDERS[source].label} ${modelFor(settings, source)} (your key, from this browser)`;
}

// fetchData: own key extracts in the browser; otherwise the server's model, when allowed.
export function describeExtractionModel(settings: ModelSettings, serverLlm: boolean): string {
  if (isProviderId(settings.source)) return describeModel(settings);
  return serverLlm ? describeModel({ ...settings, source: "server" }) : "no model";
}

export function remoteChoice(settings: ModelSettings): RemoteModelChoice | undefined {
  const { source } = settings;
  if (!isProviderId(source)) return undefined;
  return { provider: source, model: modelFor(settings, source), apiKey: settings.keys[source]?.trim() ?? "" };
}

const STORAGE_KEY = "aipanel:model-settings";
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: ModelSettings = DEFAULT_SETTINGS;

function parse(raw: string | null): ModelSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const v = JSON.parse(raw) as Partial<ModelSettings>;
    const source = v.source === "server" || v.source === "local" || isProviderId(v.source) ? v.source : "server";
    return { source, keys: { ...v.keys }, models: { ...v.models } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getSettings(): ModelSettings {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

export function getServerSettings(): ModelSettings {
  return DEFAULT_SETTINGS;
}

export function saveSettings(settings: ModelSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked: settings last until the page reloads.
    cachedRaw = JSON.stringify(settings);
    cached = settings;
  }
  listeners.forEach((l) => l());
}

export function subscribeSettings(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => e.key === STORAGE_KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
