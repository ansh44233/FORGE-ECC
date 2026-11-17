export type DiagnosableProvider = "openai" | "anthropic" | "google" | "ollama";
export interface ProviderDiagnostic {
  provider: DiagnosableProvider;
  status: "connected" | "needs-credentials" | "unauthorized" | "unavailable" | "error";
  checkedAt: string;
  durationMs: number;
  model: string;
  modelAvailable: boolean | null;
  modelCount: number | null;
  message: string;
}

const defaults: Record<DiagnosableProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
};

function endpointOrigin(value: string, provider: DiagnosableProvider): URL {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(provider === "ollama" && url.protocol === "http:" && local))) {
    throw new Error("Provider endpoint must use HTTPS (localhost HTTP is allowed for Ollama) and must not contain credentials, query parameters or fragments.");
  }
  return url;
}

function modelNames(payload: unknown, provider: DiagnosableProvider): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as Record<string, unknown>;
  if (provider === "ollama") {
    return Array.isArray(data.models) ? data.models.flatMap(item => item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" ? [(item as { name: string }).name] : []) : [];
  }
  if (provider === "google") {
    return Array.isArray(data.models) ? data.models.flatMap(item => item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" ? [(item as { name: string }).name.replace(/^models\//, "")] : []) : [];
  }
  return Array.isArray(data.data) ? data.data.flatMap(item => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : []) : [];
}

export async function diagnoseProvider(
  provider: DiagnosableProvider,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<ProviderDiagnostic> {
  const started = Date.now();
  const model = env.FORGE_AI_MODEL || env.FORGE_MODEL || (provider === "openai" ? "gpt-4.1-mini" : provider === "anthropic" ? "claude-sonnet-4-5" : provider === "google" ? "gemini-2.5-flash" : "llama3.2");
  const checkedAt = new Date().toISOString();
  const key = provider === "openai" ? env.FORGE_API_KEY || env.OPENAI_API_KEY : provider === "anthropic" ? env.ANTHROPIC_API_KEY : provider === "google" ? env.GOOGLE_API_KEY : undefined;
  const finish = (status: ProviderDiagnostic["status"], message: string, modelAvailable: boolean | null = null, modelCount: number | null = null): ProviderDiagnostic => ({
    provider, status, checkedAt, durationMs: Date.now() - started, model, modelAvailable, modelCount, message,
  });
  if (provider !== "ollama" && !key?.trim()) return finish("needs-credentials", "Required API credential is not configured.");
  try {
    const configured = env.FORGE_BASE_URL || (provider === "ollama" ? env.OLLAMA_HOST : undefined) || defaults[provider];
    const base = endpointOrigin(configured, provider).toString().replace(/\/+$/, "");
    let url: string;
    const headers: Record<string, string> = {};
    if (provider === "openai") {
      url = base + "/models";
      headers.authorization = "Bearer " + key;
    } else if (provider === "anthropic") {
      url = base + "/v1/models";
      headers["x-api-key"] = key!;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider === "google") {
      url = base + "/v1beta/models";
      headers["x-goog-api-key"] = key!;
    } else {
      url = base + "/api/tags";
    }
    const response = await fetcher(url, { method: "GET", headers, signal: AbortSignal.timeout(8000), redirect: "error" });
    if (response.status === 401 || response.status === 403) return finish("unauthorized", "Provider rejected the configured credentials.");
    if (!response.ok) return finish("unavailable", "Provider returned HTTP " + response.status + ".");
    const payload: unknown = await response.json();
    const names = modelNames(payload, provider);
    const available = names.length ? names.some(name => name === model || name.endsWith("/" + model)) : null;
    return finish("connected", available === false ? "Connection succeeded, but the configured model was not found in the model list." : "Provider API responded successfully.", available, names.length);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return finish("error", timedOut ? "Provider check timed out after 8 seconds." : error instanceof Error && error.message.startsWith("Provider endpoint") ? error.message : "Could not reach provider. Check endpoint and network access.");
  }
}
