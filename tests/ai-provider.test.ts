import { describe, expect, it } from "vitest";
import { createAIProvider, MockAIProvider, readAIProviderConfig } from "../src/ai/provider.js";

describe("AI provider foundation", () => {
  it("defaults to the offline mock provider without credentials", () => {
    expect(readAIProviderConfig({}).provider).toBe("mock");
  });

  it("returns a clear error when a hosted provider has no API key", () => {
    expect(() => readAIProviderConfig({ FORGE_AI_PROVIDER: "anthropic" }))
      .toThrow("ANTHROPIC_API_KEY is not set");
  });

  it("does not pretend an unimplemented provider adapter is available", () => {
    expect(() => createAIProvider({ provider: "openai", apiKey: "test-key" }))
      .toThrow("provider adapter is not installed yet");
  });

  it("provides an offline response without network access", async () => {
    const provider = new MockAIProvider();
    const response = await provider.generate({
      messages: [{ role: "user", content: "Plan a safe refactor" }],
    });
    expect(response.provider).toBe("mock");
    expect(response.text).toContain("No external AI service was contacted");
    expect(response.text).toContain("Plan a safe refactor");
  });
});
