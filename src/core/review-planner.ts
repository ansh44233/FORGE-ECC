import { createRun, type AgentTask, type RunRecord } from "./orchestrator.js";

export function createReviewPlan(goal: string): RunRecord {
  const normalized = goal.trim();
  if (!normalized) throw new Error("Provide a goal after --goal.");

  const tasks: AgentTask[] = [
    {
      id: "understand",
      agent: "architect",
      title: "Understand project structure and change scope",
      prompt: `Inspect the relevant project structure and conventions for this goal: ${normalized}. Identify affected modules, assumptions, constraints and important interfaces. Do not modify files.`,
    },
    {
      id: "plan",
      agent: "planner",
      title: "Create an implementation plan",
      prompt: `Using the project understanding, produce an ordered implementation plan for: ${normalized}. Include file-level scope, acceptance criteria, risks and verification steps. Do not modify files.`,
      dependsOn: ["understand"],
    },
    {
      id: "review",
      agent: "code-reviewer",
      title: "Review correctness and regression risks",
      prompt: `Review the proposed approach for ${normalized}. Identify correctness defects, edge cases, compatibility risks and missing tests. Cite evidence and distinguish confirmed issues from hypotheses.`,
      dependsOn: ["plan"],
    },
    {
      id: "security",
      agent: "security-reviewer",
      title: "Review security and trust boundaries",
      prompt: `Assess the proposed approach for ${normalized} for input validation, permissions, secrets, filesystem/process/network boundaries and untrusted content. Report concrete risks and mitigations.`,
      dependsOn: ["plan"],
    },
    {
      id: "performance",
      agent: "performance-engineer",
      title: "Review performance implications",
      prompt: `Assess likely performance implications of ${normalized}. Identify measurable bottleneck hypotheses, complexity or resource risks, and benchmarks that would validate them. Do not invent measurements.`,
      dependsOn: ["plan"],
    },
    {
      id: "debugging",
      agent: "debugger",
      title: "Identify diagnostic and failure scenarios",
      prompt: `Identify likely failure modes related to ${normalized}. Propose a hypothesis-led debugging and reproduction strategy. Clearly label hypotheses; do not claim to have executed tests.`,
      dependsOn: ["plan"],
    },
    {
      id: "tests",
      agent: "test-engineer",
      title: "Define verification strategy",
      prompt: `Define unit, integration, boundary and failure tests for ${normalized}. Distinguish suggested checks from checks actually executed.`,
      dependsOn: ["plan"],
    },
    {
      id: "docs",
      agent: "documentation-writer",
      title: "Review documentation impact",
      prompt: `Identify documentation, examples, configuration references and migration notes affected by ${normalized}. Keep proposed documentation consistent with verified behavior.`,
      dependsOn: ["plan"],
    },
    {
      id: "delivery",
      agent: "devops-engineer",
      title: "Review CI and delivery impact",
      prompt: `Identify build, CI, release and deployment checks needed for ${normalized}. Do not claim any workflow passed without run evidence.`,
      dependsOn: ["plan"],
    },
    {
      id: "release",
      agent: "release-manager",
      title: "Prepare engineering readiness summary",
      prompt: `Synthesize the preceding specialist findings for ${normalized}. Produce a concise readiness summary, unresolved risks, required checks and go/no-go recommendation. Mark all unverified claims explicitly.`,
      dependsOn: ["review", "security", "performance", "debugging", "tests", "docs", "delivery"],
    },
  ];

  return createRun(normalized, tasks);
}
