import { describe, expect, it } from "vitest";
import { validateBenchmarkMatrix } from "../src/core/benchmark-matrix.js";

describe("hosted provider benchmark candidates", () => {
  it.each(["openai", "anthropic", "google", "ollama", "claude-code"] as const)("accepts %s candidates", provider => {
    const matrix = {
      id: "provider-matrix",
      name: "Provider matrix",
      repeats: 1,
      candidates: [
        { id: "candidate-one", provider, model: "model-one" },
        { id: "candidate-two", provider, model: "model-two" },
      ],
    };
    expect(validateBenchmarkMatrix(matrix).candidates[0]?.provider).toBe(provider);
  });

  it("rejects unknown provider identifiers", () => {
    const matrix = {
      id: "provider-matrix",
      name: "Provider matrix",
      repeats: 1,
      candidates: [
        { id: "candidate-one", provider: "unknown", model: "model-one" },
        { id: "candidate-two", provider: "openai", model: "model-two" },
      ],
    };
    expect(() => validateBenchmarkMatrix(matrix)).toThrow("Unsupported benchmark candidate provider");
  });
});
