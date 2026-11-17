import type { BenchmarkMatrixConfig } from "./benchmark-matrix.js";
import { validateBenchmarkMatrix } from "./benchmark-matrix.js";

export interface SkillExperimentStudioInput {
  id: string;
  name: string;
  baselineCandidateId: string;
  treatmentCandidateId: string;
  provider: "openai" | "claude-code" | "anthropic" | "google" | "ollama";
  model: string;
  repeats: number;
  skillIds: string[];
}
export function createSkillExperimentMatrix(input: SkillExperimentStudioInput): BenchmarkMatrixConfig {
  const matrix: BenchmarkMatrixConfig = {
    id: input.id,
    name: input.name,
    repeats: input.repeats,
    candidates: [
      { id: input.baselineCandidateId, provider: input.provider, model: input.model, skillIds: [] },
      { id: input.treatmentCandidateId, provider: input.provider, model: input.model, skillIds: [...input.skillIds] }
    ],
    skillExperiment: {
      baselineCandidateId: input.baselineCandidateId,
      treatmentCandidateId: input.treatmentCandidateId,
      skillIds: [...input.skillIds]
    }
  };
  return validateBenchmarkMatrix(matrix);
}
export function formatSkillExperimentMatrix(matrix: BenchmarkMatrixConfig): string {
  const experiment = matrix.skillExperiment!;
  return [
    "FORGE Experiment Studio · " + matrix.name,
    "Matrix ID: " + matrix.id,
    "Provider/model: " + matrix.candidates[0]!.provider + "/" + matrix.candidates[0]!.model,
    "Repeats per candidate: " + matrix.repeats,
    "",
    "Baseline: " + experiment.baselineCandidateId,
    "  Skills: none (explicit empty skill set)",
    "Treatment: " + experiment.treatmentCandidateId,
    "  Skills: " + experiment.skillIds.join(", "),
    "",
    "Next: forge benchmark-matrix <CONFIG_FILE> --suite <SUITE_ID> --goal \"<task>\"",
    "",
    "This scaffold isolates the selected skill set. Agent configuration snapshots are not hydrated by this scaffold; use the active workspace agent files consistently across both candidates."
  ].join("\n");
}

export interface ModelComparisonCandidateInput {
  id: string;
  provider: "openai" | "claude-code" | "anthropic" | "google" | "ollama";
  model: string;
  configVersionId?: string;
}
export interface ModelComparisonStudioInput {
  id: string;
  name: string;
  repeats: number;
  candidates: ModelComparisonCandidateInput[];
}
export function createModelComparisonMatrix(input: ModelComparisonStudioInput): BenchmarkMatrixConfig {
  return validateBenchmarkMatrix({
    id: input.id,
    name: input.name,
    repeats: input.repeats,
    candidates: input.candidates.map(candidate => ({
      id: candidate.id,
      provider: candidate.provider,
      model: candidate.model,
      ...(candidate.configVersionId ? { configVersionId: candidate.configVersionId } : {})
    }))
  });
}
export function formatModelComparisonMatrix(matrix: BenchmarkMatrixConfig): string {
  return [
    "FORGE Model Comparison Studio · " + matrix.name,
    "Matrix ID: " + matrix.id,
    "Candidates: " + matrix.candidates.length,
    "Repeats per candidate: " + matrix.repeats,
    "",
    ...matrix.candidates.map((candidate, index) => (index + 1) + ". " + candidate.id + " — " + candidate.provider + "/" + candidate.model + (candidate.configVersionId ? " · config " + candidate.configVersionId : " · active workspace configuration")),
    "",
    "Total planned trials: " + matrix.candidates.length * matrix.repeats,
    "Next: forge benchmark-matrix <CONFIG_FILE> --suite <SUITE_ID> --goal \"<task>\"",
    "",
    "Candidates run sequentially against the same suite and goal. For a fair comparison, keep the evaluation suite, workspace, permissions and environment unchanged."
  ].join("\n");
}
