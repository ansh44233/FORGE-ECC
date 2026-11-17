import { ClaudeCodeProvider } from "./claude-code-provider.js";
/**
 * Provider-neutral AI contract for FORGE.
 *
 * Core repository intelligence and MCP tools do not depend on an AI provider.
 * Real provider adapters can implement this interface without changing agents.
 */
export type AIProviderId = "mock" | "claude-code" | "anthropic" | "openai" | "google" | "ollama";

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIRequest {
  model?: string;
  messages: AIMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AIResponse {
  provider: AIProviderId;
  model: string;
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface AIProvider {
  readonly id: AIProviderId;
  generate(request: AIRequest): Promise<AIResponse>;
}

export interface AIProviderConfig {
  provider: AIProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

const PROVIDER_ENV: Record<Exclude<AIProviderId, "mock" | "claude-code">, {
  key: string;
  model: string;
  baseUrl?: string;
}> = {
  anthropic: { key: "ANTHROPIC_API_KEY", model: "claude-sonnet" },
  openai: { key: "OPENAI_API_KEY", model: "gpt-4.1-mini" },
  google: { key: "GOOGLE_API_KEY", model: "gemini-flash" },
  ollama: { key: "OLLAMA_HOST", model: "llama3.2", baseUrl: "http://localhost:11434" },
};

export function readAIProviderConfig(env: NodeJS.ProcessEnv = process.env): AIProviderConfig {
  const raw = (env.FORGE_AI_PROVIDER ?? "mock").trim().toLowerCase();
  if (!["mock", "claude-code", "anthropic", "openai", "google", "ollama"].includes(raw)) {
    throw new Error(`Unsupported FORGE_AI_PROVIDER "${raw}". Choose mock, claude-code, anthropic, openai, google, or ollama.`);
  }

  const provider = raw as AIProviderId;
  if (provider === "mock" || provider === "claude-code") return { provider, ...(env.FORGE_AI_MODEL ? { model: env.FORGE_AI_MODEL } : {}) };

  const defaults = PROVIDER_ENV[provider];
  const apiKey = provider === "ollama" ? undefined : env[defaults.key];
  const baseUrl = provider === "ollama" ? (env.OLLAMA_HOST ?? defaults.baseUrl) : undefined;

  if (provider !== "ollama" && !apiKey) {
    throw new Error(`${provider} is selected but ${defaults.key} is not set. Use FORGE_AI_PROVIDER=mock to work without a paid provider account.`);
  }

  return {
    provider,
    model: env.FORGE_AI_MODEL ?? defaults.model,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** Safe offline provider for tests, demos and installations without API credentials. */
export class MockAIProvider implements AIProvider {
  readonly id = "mock" as const;

  async generate(request: AIRequest): Promise<AIResponse> {
    const latestUserMessage = [...request.messages].reverse().find(message => message.role === "user");
    return {
      provider: this.id,
      model: request.model ?? "forge-mock",
      text: [
        "FORGE mock provider response",
        "No external AI service was contacted and no API credentials were used.",
        latestUserMessage ? `Received task: ${latestUserMessage.content.slice(0, 500)}` : "No user task was supplied.",
        "Configure a supported provider adapter to enable model-generated responses.",
      ].join("\n"),
    };
  }
}

/**
 * Resolve the configured provider. Network adapters are deliberately registered
 * separately; selecting one before its adapter is installed fails explicitly.
 */
export function createAIProvider(config: AIProviderConfig): AIProvider {
  if (config.provider === "mock") return new MockAIProvider();
  if (config.provider === "claude-code") return new ClaudeCodeProvider(config.model ? { model: config.model } : {});
  throw new Error(
    `The ${config.provider} provider adapter is not installed yet. FORGE core and MCP work without it; use FORGE_AI_PROVIDER=mock until an adapter is configured.`,
  );
}
