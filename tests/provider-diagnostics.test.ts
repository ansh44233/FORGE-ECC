import { describe, expect, it, vi } from "vitest";
import { diagnoseProvider } from "../src/core/provider-diagnostics.js";

describe("provider diagnostics", () => {
  it("does not make a request when credentials are missing", async () => {
    const fetcher = vi.fn();
    const result = await diagnoseProvider("openai", {}, fetcher as unknown as typeof fetch);
    expect(result.status).toBe("needs-credentials");
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.message).not.toContain("test-secret");
  });

  it("reports a successful OpenAI connection and model availability", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-4.1-mini" }, { id: "other" }] }), { status: 200 }));
    const result = await diagnoseProvider("openai", { OPENAI_API_KEY: "test-secret", FORGE_AI_MODEL: "gpt-4.1-mini" }, fetcher as unknown as typeof fetch);
    expect(result).toMatchObject({ status: "connected", modelAvailable: true, modelCount: 2, model: "gpt-4.1-mini" });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(result.message).not.toContain("test-secret");
  });

  it("distinguishes unauthorized credentials", async () => {
    const fetcher = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const result = await diagnoseProvider("anthropic", { ANTHROPIC_API_KEY: "test-secret" }, fetcher as unknown as typeof fetch);
    expect(result.status).toBe("unauthorized");
    expect(result.message).not.toContain("test-secret");
  });

  it("reports when the configured Ollama model is not installed", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "llama3.1" }] }), { status: 200 }));
    const result = await diagnoseProvider("ollama", { FORGE_AI_MODEL: "llama3.2" }, fetcher as unknown as typeof fetch);
    expect(result).toMatchObject({ status: "connected", modelAvailable: false, modelCount: 1 });
  });

  it("rejects remote HTTP endpoints without contacting them", async () => {
    const fetcher = vi.fn();
    const result = await diagnoseProvider("ollama", { OLLAMA_HOST: "http://remote.example:11434" }, fetcher as unknown as typeof fetch);
    expect(result.status).toBe("error");
    expect(result.message).toContain("HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not leak endpoint credentials or query parameters", async () => {
    const fetcher = vi.fn();
    const result = await diagnoseProvider("ollama", { OLLAMA_HOST: "https://user:secret@example.test?token=secret" }, fetcher as unknown as typeof fetch);
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("classifies provider HTTP failures without exposing response bodies", async () => {
    const fetcher = vi.fn(async () => new Response("private provider response", { status: 503 }));
    const result = await diagnoseProvider("google", { GOOGLE_API_KEY: "test-secret" }, fetcher as unknown as typeof fetch);
    expect(result.status).toBe("unavailable");
    expect(result.message).not.toContain("private provider response");
  });
});
