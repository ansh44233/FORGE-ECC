import type { BenchmarkMatrixReport } from "./benchmark-matrix.js";

export interface AgentOptimizationSuggestion {
  agent: string;
  candidateId: string;
  baselineScore: number | null;
  currentScore: number;
  scoreDelta: number | null;
  repeatedFailures: Array<{ criterionId: string; count: number; examples: string[] }>;
  recommendedActions: string[];
  skillIdsObserved: string[];
  confidence: "low" | "medium";
}
export interface AgentOptimizationPlan {
  status: "recommendations" | "insufficient-history";
  suiteId: string;
  goal: string;
  baselineAt: string;
  currentAt: string;
  suggestions: AgentOptimizationSuggestion[];
  guardrails: string[];
}
export function buildAgentOptimizationPlan(history: BenchmarkMatrixReport[]): AgentOptimizationPlan {
  const eligible = history.filter(item => item.summary.length > 0).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  const current = eligible.at(-1);
  const baseline = current ? [...eligible.slice(0,-1)].reverse().find(item => item.suiteId === current.suiteId && item.goal === current.goal) : undefined;
  const guardrails = [
    "Recommendations are advisory; FORGE does not rewrite prompts, skills or agent configuration automatically.",
    "Validate every proposed change with a fresh controlled benchmark using the same suite, goal, provider and model.",
    "Rubric failures are diagnostic signals, not proof of root cause. Inspect the underlying agent outputs before changing configuration."
  ];
  if (!current || !baseline) return { status: "insufficient-history", suiteId: current?.suiteId ?? "", goal: current?.goal ?? "", baselineAt: baseline?.createdAt ?? "", currentAt: current?.createdAt ?? "", suggestions: [], guardrails };
  const suggestions: AgentOptimizationSuggestion[] = [];
  for (const now of current.agentSummary ?? []) {
    const previous = (baseline.agentSummary ?? []).find(item => item.candidateId === now.candidateId && item.agent === now.agent && item.provider === now.provider && item.model === now.model);
    const results = current.results.filter(result => result.candidateId === now.candidateId && result.status === "completed");
    const failures = new Map<string, { count: number; examples: string[] }>();
    for (const result of results) for (const score of result.agentScores ?? []) {
      if (score.agent !== now.agent) continue;
      for (const failed of score.failedCriteria ?? []) {
        const item = failures.get(failed.id) ?? { count: 0, examples: [] };
        item.count += 1;
        for (const example of failed.failedChecks.slice(0,2)) if (item.examples.length < 4 && !item.examples.includes(example)) item.examples.push(example);
        failures.set(failed.id,item);
      }
    }
    const repeatedFailures = [...failures.entries()].filter(([,item]) => item.count >= 2).map(([criterionId,item]) => ({ criterionId, ...item })).sort((a,b) => b.count-a.count || a.criterionId.localeCompare(b.criterionId));
    const delta = previous ? Math.round((now.averageScore-previous.averageScore)*10)/10 : null;
    const actions: string[] = [];
    if (repeatedFailures.length) {
      actions.push("Inspect the task outputs for repeated failures in: " + repeatedFailures.map(item => item.criterionId).join(", ") + ".");
      actions.push("Add explicit, evidence-based instructions and a verification checklist for these criteria to this agent's task prompt or a dedicated skill.");
    }
    if (delta !== null && delta <= -5) actions.push("Compare this agent's current outputs with the prior baseline and isolate recent prompt, skill or model-context changes before editing.");
    if (now.passRate < 80) actions.push("Add a targeted evaluation case for the weakest behavior and require a passing rerun before accepting a configuration change.");
    if (!actions.length) continue;
    suggestions.push({ agent: now.agent, candidateId: now.candidateId, baselineScore: previous?.averageScore ?? null, currentScore: now.averageScore, scoreDelta: delta, repeatedFailures, recommendedActions: actions, skillIdsObserved: now.skillsObserved ?? [], confidence: repeatedFailures.length >= 2 && previous ? "medium" : "low" });
  }
  return { status: "recommendations", suiteId: current.suiteId, goal: current.goal, baselineAt: baseline.createdAt, currentAt: current.createdAt, suggestions, guardrails };
}
export function formatAgentOptimizationPlan(plan: AgentOptimizationPlan): string {
  const lines = ["FORGE Adaptive Agent Optimization", "Status: " + plan.status.toUpperCase(), "Suite: " + (plan.suiteId || "not available"), "Goal: " + (plan.goal || "not available"), ""];
  if (!plan.suggestions.length) lines.push(plan.status === "insufficient-history" ? "Run the same evaluation suite and goal twice to establish comparable history." : "No repeated agent failure patterns were found in the latest comparable run.");
  for (const item of plan.suggestions) {
    lines.push(item.agent + " · " + item.candidateId + " · score " + (item.baselineScore === null ? "no baseline" : item.baselineScore + " → " + item.currentScore + " (" + item.scoreDelta + ")"));
    lines.push("  Repeated rubric failures: " + (item.repeatedFailures.map(failure => failure.criterionId + " (" + failure.count + ")").join(", ") || "none"));
    lines.push("  Skills observed: " + (item.skillIdsObserved.join(", ") || "none"));
    for (const action of item.recommendedActions) lines.push("  RECOMMEND: " + action);
  }
  lines.push("", "Guardrails:");
  for (const guardrail of plan.guardrails) lines.push("  - " + guardrail);
  return lines.join("\n");
}
