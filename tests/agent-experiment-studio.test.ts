import { describe, expect, it } from "vitest";
import { createSkillExperimentMatrix, formatSkillExperimentMatrix, createModelComparisonMatrix, formatModelComparisonMatrix } from "../src/core/agent-experiment-studio.js";

describe("agent experiment studio", () => {
  it("creates a validated baseline and treatment skill matrix", () => {
    const matrix = createSkillExperimentMatrix({ id: "secure-skill-test", name: "Secure skill treatment", baselineCandidateId: "baseline", treatmentCandidateId: "with-secure-skill", provider: "openai", model: "gpt-test", repeats: 2, skillIds: ["secure-changes"] });
    expect(matrix.candidates[0]?.skillIds).toEqual([]);
    expect(matrix.candidates[1]?.skillIds).toEqual(["secure-changes"]);
    expect(matrix.skillExperiment?.baselineCandidateId).toBe("baseline");
    expect(formatSkillExperimentMatrix(matrix)).toContain("Skills: none");
    expect(formatSkillExperimentMatrix(matrix)).toContain("secure-changes");
  });
  it("rejects a matrix that changes provider/model or omits treatment skills", () => {
    expect(() => createSkillExperimentMatrix({ id: "invalid-experiment", name: "Invalid", baselineCandidateId: "baseline", treatmentCandidateId: "treatment", provider: "openai", model: "gpt-test", repeats: 2, skillIds: [] })).toThrow("unique valid skill IDs");
  });

  it("creates a validated multi-provider model comparison matrix", () => {
    const matrix = createModelComparisonMatrix({
      id: "provider-compare",
      name: "Provider comparison",
      repeats: 3,
      candidates: [
        { id: "openai-fast", provider: "openai", model: "gpt-4.1-mini", configVersionId: "cfg-0123456789ab" },
        { id: "claude-sonnet", provider: "claude-code", model: "sonnet" },
        { id: "gemini-flash", provider: "google", model: "gemini-2.5-flash" }
      ]
    });
    expect(matrix.candidates).toHaveLength(3);
    expect(matrix.candidates.map(item => item.provider)).toEqual(["openai", "claude-code", "google"]);
    expect(formatModelComparisonMatrix(matrix)).toContain("Total planned trials: 9");
    expect(formatModelComparisonMatrix(matrix)).toContain("config cfg-0123456789ab");
  });

  it("rejects duplicate candidate IDs and invalid repeat counts", () => {
    expect(() => createModelComparisonMatrix({
      id: "duplicate-candidates", name: "Duplicate", repeats: 2,
      candidates: [
        { id: "same", provider: "openai", model: "gpt-test" },
        { id: "same", provider: "google", model: "gemini-test" }
      ]
    })).toThrow("unique valid id");
    expect(() => createModelComparisonMatrix({
      id: "too-many-repeats", name: "Invalid repeats", repeats: 4,
      candidates: [
        { id: "one", provider: "openai", model: "gpt-test" },
        { id: "two", provider: "google", model: "gemini-test" }
      ]
    })).toThrow("repeats must be between 1 and 3");
  });

  it("requires distinct valid candidate IDs and bounded repeat count", () => {
    expect(() => createSkillExperimentMatrix({ id: "bad", name: "Bad", baselineCandidateId: "same", treatmentCandidateId: "same", provider: "openai", model: "gpt-test", repeats: 2, skillIds: ["secure-changes"] })).toThrow("unique valid id");
    expect(() => createSkillExperimentMatrix({ id: "bad-repeats", name: "Bad repeats", baselineCandidateId: "baseline", treatmentCandidateId: "treatment", provider: "openai", model: "gpt-test", repeats: 4, skillIds: ["secure-changes"] })).toThrow("repeats must be between 1 and 3");
  });
});
