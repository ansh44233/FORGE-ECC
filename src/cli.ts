#!/usr/bin/env node

import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { initializeProject } from "./core/project-init.js";
import { formatArchitectureMap, mapArchitecture } from "./core/architecture-map.js";
import { formatProjectReport, inspectProject } from "./core/project-inspector.js";
import { loadAgentRegistry } from "./core/agent-registry.js";
import { createReviewPlan } from "./core/review-planner.js";
import { saveRun, listRuns, loadRun, decideTaskApproval, recoverInterruptedRun, withRunExecutionLock } from "./core/run-store.js";
import { advanceRun, type RunRecord } from "./core/orchestrator.js";
import { formatRunHistoryJson } from "./core/run-history-output.js";
import { OpenAICompatibleProvider } from "./core/openai-compatible-provider.js";
import { createHostedAgentProvider } from "./core/hosted-agent-provider.js";
import { ClaudeCodeProvider } from "./ai/claude-code-provider.js";
import { startDashboard } from "./core/dashboard-server.js";
import { auditProject, formatQualityAudit } from "./core/quality-audit.js";
import { discoverChecks, formatVerificationResult, runVerification } from "./core/verification.js";
import { compareVerification, formatVerificationComparison, listVerifications, saveVerification } from "./core/verification-history.js";
import { formatProjectHealthMarkdown, generateProjectHealth } from "./core/project-health.js";
import { analyzeCodebase, formatCodebaseAnalysis } from "./core/code-intelligence.js";
import { analyzeGitChanges, formatGitIntelligence } from "./core/git-intelligence.js";
import { reviewProject, formatCodeReview } from "./core/code-review.js";
import { generateAIReview, formatAIReview } from "./core/ai-code-review.js";
import { compareReviews, formatReviewRecord, listReviews, loadReview, saveReview } from "./core/review-history.js";
import { formatPatchValidation, validateReviewPatch } from "./core/patch-validation.js";
import { approveReviewPatch, verifyPatchApproval } from "./core/patch-approval.js";
import { stageApprovedPatch, reviewStagedPatch } from "./core/patch-application.js";
import { verifyStagedPatch } from "./core/staged-verification.js";
import { formatSandboxRuntimeReport, parseSandboxRuntimeReport } from "./core/sandbox-runtime.js";
import { detectDockerRootless } from "./core/container-sandbox.js";
import { formatSandboxCleanupReport, parseManagedContainers, selectStoppedManagedContainers } from "./core/sandbox-lifecycle.js";
import { getSandboxSecurityProfile, listSandboxSecurityProfiles } from "./core/sandbox-security-profiles.js";
import { createSandboxComplianceReport, formatSandboxComplianceReport } from "./core/sandbox-compliance.js";
import { formatSandboxPolicyValidation, loadSandboxPolicy } from "./core/sandbox-policy.js";
import { appendSandboxCleanupAudit, formatSandboxCleanupHistory, readSandboxCleanupAudit } from "./core/sandbox-cleanup-audit.js";
import { formatRegressionReport, generateRegressionReport } from "./core/regression-intelligence.js";
import { searchWorkspace } from "./core/code-search.js";
import { buildAgentWorkspaceContext } from "./core/agent-workspace-context.js";
import { analyzeDependencyImpact, formatDependencyImpact } from "./core/dependency-impact.js";
import { analyzeEngineeringRisk, formatEngineeringRisk } from "./core/engineering-risk.js";
import { analyzeChangeIntelligence, formatChangeIntelligence } from "./core/change-intelligence.js";
import { captureIntelligenceSnapshot, compareLatestIntelligence, formatIntelligenceComparison } from "./core/intelligence-timeline.js";
import { analyzeDependencies, formatDependencyIntelligence } from "./core/dependency-intelligence.js";
import { generateRemediationPlan, formatRemediationPlan } from "./core/remediation-planner.js";
import { addProjectMemory, buildProjectMemoryContext, listProjectMemory, removeProjectMemory, type ProjectMemoryKind } from "./core/project-memory.js";
import { formatSkillContext, loadSkillRegistry, selectSkills } from "./core/skill-registry.js";
import { applyBeforeAgentHooks, loadHooks } from "./core/hook-engine.js";
import { assertSupportedAgentPolicy, loadPermissionPolicy } from "./core/permission-policy.js";
import { ModelRouter } from "./core/model-router.js";
import { loadExecutionTrace, saveExecutionTrace } from "./core/execution-trace.js";
import { createReplayRun } from "./core/run-replay.js";
import { evaluateRun, evaluateRunWithJudge, formatEvaluationReport, loadEvaluationSuites, saveEvaluationReport, loadEvaluationReport, type EvaluationReport, type JudgedEvaluationReport } from "./core/evaluation-engine.js";
import { createBenchmarkTrial, formatBenchmark, listBenchmarks, recordBenchmarkTrial } from "./core/benchmark-engine.js";
import { executeBenchmarkMatrix, formatBenchmarkMatrix, loadBenchmarkMatrix, listBenchmarkMatrices, saveBenchmarkMatrix } from "./core/benchmark-matrix.js";
import { fingerprintAgentConfig } from "./core/benchmark-matrix.js";
import { loadAgentConfigVersion } from "./core/agent-config-versioning.js";
import { formatBenchmarkRegression, loadBenchmarkRegression } from "./core/benchmark-regression.js";
import { buildAgentOptimizationPlan, formatAgentOptimizationPlan } from "./core/agent-optimization.js";
import { auditAgentConfiguration, formatAgentSecurityReport } from "./core/agent-security-audit.js";
import { buildAgentEvaluationIntelligence, formatAgentEvaluationIntelligence } from "./core/agent-evaluation-intelligence.js";
import { assessAgentEvolution, formatAgentEvolutionAssessment } from "./core/agent-evolution.js";
import { createSkillExperimentMatrix, formatSkillExperimentMatrix, createModelComparisonMatrix, formatModelComparisonMatrix } from "./core/agent-experiment-studio.js";
import { buildExperimentHistory, formatExperimentHistory } from "./core/experiment-history.js";
import { captureAgentConfigVersion, compareAgentConfigVersions, formatAgentConfigVersion, listAgentConfigVersions, materializeAgentConfigVersion } from "./core/agent-config-versioning.js";
import { decideAgentConfigRelease, formatAgentConfigRelease, listAgentConfigReleases, prepareAgentConfigRelease } from "./core/agent-config-release.js";
import { captureExperimentManifest, compareExperimentManifests, formatExperimentManifest, loadExperimentManifest, saveExperimentManifest } from "./core/experiment-manifest.js";

function runSandboxProbe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    const append = (chunk: Buffer | string) => {
      if (output.length < 4096) output += chunk.toString().slice(0, 4096 - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", error => finish(error));
    child.once("close", code => code === 0 ? finish() : finish(new Error("Docker probe exited with status " + code + ".")));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Docker probe timed out after 15 seconds."));
    }, 15_000);
  });
}

function readAgentTokenBudgets(): Record<string, number> | undefined {
  const raw = process.env.FORGE_MAX_ESTIMATED_TOKENS_PER_AGENT;
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("FORGE_MAX_ESTIMATED_TOKENS_PER_AGENT must be a JSON object mapping agent IDs to token limits.");
  const budgets: Record<string, number> = {};
  for (const [agent, value] of Object.entries(parsed)) {
    if (!agent.trim() || !Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Every per-agent token budget must be a positive integer.");
    budgets[agent] = value as number;
  }
  return budgets;
}

function readAgentDurationBudgets(): Record<string, number> | undefined {
  const raw = process.env.FORGE_MAX_TASK_DURATION_MS_BY_AGENT;
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("FORGE_MAX_TASK_DURATION_MS_BY_AGENT must be a JSON object mapping agent IDs to milliseconds.");
  const budgets: Record<string, number> = {};
  for (const [agent, value] of Object.entries(parsed)) {
    if (!agent.trim() || !Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Every per-agent duration budget must be a positive integer number of milliseconds.");
    budgets[agent] = value as number;
  }
  return budgets;
}

const VERSION = "1.0.0";

const HELP = `
FORGE — The AI Engineering Workbench

Usage:
  forge <command> [options]

Commands:
  init [path]      Create a safe, local-first .forge starter workspace
  inspect [path]   Analyze project languages, tooling, dependencies, and scripts
  evaluate RUNID  Score a saved run against a local evaluation suite
  benchmark [RUN_ID] [--suite SUITE_ID] [--path PROJECT]  Record or view benchmark results
  benchmark-matrix CONFIG.json --suite SUITE_ID --goal "..." [--path PROJECT]  Run model comparisons\n  benchmark-regression [MATRIX_ID] [--path PROJECT]  Compare latest matrix with its baseline\n  optimize-agents [--path PROJECT]  Recommend evidence-based agent improvements
  agent-intelligence [--suite ID] [--candidate ID] [--limit N] [--path PROJECT]  Score agent effectiveness across benchmark history
  agent-evolution MATRIX_ID [--path PROJECT]  Evaluate a controlled baseline/treatment experiment
  experiment-studio <create|compare> [options]  Scaffold a skill or multi-model experiment
  experiment-history [--suite ID] [--candidate ID] [--limit N] [--json] [--path PROJECT]  Rank historical benchmark candidates
  agent-config <snapshot|list|show|diff|approve> [options]  Version and review agent/skill configuration
  agent-release <prepare|list|show|approve|reject> [options]  Gate agent configuration promotion
  experiment <capture|show|compare> [options]  Capture and compare reproducible benchmark manifests
  quality [path]   Generate an evidence-based static engineering quality report
  deps [path]       Analyze npm dependencies, licenses, and imported security reports\n  snapshot [path]   Capture a local engineering intelligence snapshot
  timeline [path]   Compare the latest snapshot with its predecessor
  change-risk [path] Analyze changed-file risk, downstream impact, and test candidates
  risk [path]      Rank engineering hotspots using dependency and quality signals
  health [path]    Generate a unified engineering score, evidence coverage, and health snapshot
  deep [path]      Analyze AST symbols, circular imports, and change impact
  git [path]       Analyze changed files, impact, suggested tests, and risk
  review [path]    Review changed source files; add --ai for provider-backed suggestions
  review-history [path] List saved review snapshots
  review-show ID   Display one saved review snapshot
  review-compare A B Compare two saved reviews
  patch-check ID N  Dry-run validate AI patch N from a saved review
  regression [path] Compare verification history with Git changes and impact
  verify --list    Discover available npm scripts without running them
  verify SCRIPT    Explicitly run one selected npm script and record its result\n  patch-verify ID SCRIPT  Verify an approved staged patch in a temporary workspace\n  sandbox-status         Inspect Docker availability and advertised security options\n  sandbox-compliance [PROFILE] [IMAGE@sha256:DIGEST] Generate a sandbox compliance report
  sandbox-policy-check POLICY.json Validate a fail-closed sandbox policy file\n  sandbox-profiles [NAME] List or inspect built-in sandbox security profiles\n  sandbox-cleanup        Review stopped FORGE containers; add --apply to remove them\n  sandbox-cleanup-history [PATH] Show recorded cleanup activity
  verify-history   List saved verification runs for a project
  map [path]       Map source modules and import relationships
  agents [path]    List built-in and workspace agent roles\n  memory <action>  Manage local project memory (add, list, remove, context)\n  skills [path]    List built-in and workspace skills\n  hooks [path]     List configured declarative lifecycle hooks\n  agent-security [path] Audit agent instructions, skills, hooks, and permission files
  plan --goal TEXT Create and save a reviewable draft plan
  run --goal TEXT  Run the plan using a configured AI provider
  runs [path]      List locally saved run history (add --json for versioned JSON)\n  evals [path]     List local agent evaluation suites
  trace RUNID      Show per-agent execution telemetry
  replay RUNID     Create a new run from retryable failed tasks
  resume RUNID     Continue pending or approved tasks in a saved run
  approve RUNID TASK_ID  Approve a task awaiting human review
  show-run ID      Display one saved run (use --path for project directory)
  dashboard [path] Start the local read-only web dashboard
  version          Print the installed version
  help             Show this help message

Options:
  --json           Output machine-readable JSON
  --help           Show command usage

Examples:
  forge inspect .
  forge inspect ./my-app --json
  forge map .
  forge agents .
  forge plan --goal "Add authentication safely"
  forge run --goal "Review the API design"
  forge runs .
  forge replay forge-RUN-ID
  forge approve forge-RUN-ID TASK_ID
  forge resume forge-RUN-ID
  forge dashboard .
`.trim();

async function main(args: string[]): Promise<void> {
  const [command = "help", ...rest] = args;
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${HELP}\n`);
      return;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`forge ${VERSION}\n`);
      return;
    case "init": {
      const target = rest.find(arg => !arg.startsWith("--")) ?? ".";
      try {
        const result = await initializeProject(path.resolve(target));
        process.stdout.write(`FORGE initialized in ${path.resolve(target)}\n`);
        for (const file of result.created) process.stdout.write(`  created  ${file}\n`);
        for (const file of result.skipped) process.stdout.write(`  kept     ${file} (already exists)\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE could not initialize this project: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "evals": {
      const target = path.resolve(rest.find(arg => !arg.startsWith("--")) ?? ".");
      try {
        const suites = await loadEvaluationSuites(target);
        process.stdout.write(suites.length ? suites.map(suite => suite.id + "  " + suite.name + " · " + suite.cases.length + " cases").join("\n") + "\n" : "No evaluation suites. Add JSON suites under .forge/evals/.\n");
      } catch (error) { process.stderr.write("Could not load evaluation suites: " + (error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
      return;
    }
    case "agent-release": {
      const action = rest[0] ?? "list";
      const option = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const args = rest.slice(1).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--path" && all[index - 1] !== "--reviewer" && all[index - 1] !== "--matrix");
      try {
        if (action === "prepare") {
          const [candidateVersionId, baselineVersionId] = args;
          const matrixId = option("--matrix");
          if (!candidateVersionId || !baselineVersionId || !matrixId) throw new Error("Usage: forge agent-release prepare CANDIDATE_CONFIG_ID BASELINE_CONFIG_ID --matrix MATRIX_ID --path PROJECT");
          const regression = await loadBenchmarkRegression(target, matrixId);
          const release = await prepareAgentConfigRelease(target, { candidateVersionId, baselineVersionId, regression });
          process.stdout.write(formatAgentConfigRelease(release) + "\nHuman approval is still required. No live files were changed.\n");
        } else if (action === "list") {
          const items = await listAgentConfigReleases(target);
          process.stdout.write(items.length ? items.map(item => item.id + "  " + item.status.padEnd(17) + "  " + item.candidateVersionId + "  " + item.benchmarkStatus).join("\n") + "\n" : "No agent configuration releases found.\n");
        } else if (action === "show") {
          const id = args[0]; if (!id) throw new Error("Usage: forge agent-release show RELEASE_ID --path PROJECT");
          const item = (await listAgentConfigReleases(target)).find(entry => entry.id === id);
          if (!item) throw new Error("Release not found: " + id);
          process.stdout.write(formatAgentConfigRelease(item) + "\n");
        } else if (action === "approve" || action === "reject") {
          const id = args[0]; if (!id) throw new Error("Usage: forge agent-release approve|reject RELEASE_ID --reviewer NAME --path PROJECT");
          const reviewer = option("--reviewer"); if (!reviewer?.trim()) throw new Error("A reviewer is required via --reviewer NAME.");
          const item = await decideAgentConfigRelease(target, id, reviewer, action);
          process.stdout.write(formatAgentConfigRelease(item) + "\n");
        } else throw new Error("Unknown action. Use prepare, list, show, approve or reject.");
      } catch (error) {
        process.stderr.write("FORGE agent release failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
        process.exitCode = 1;
      }
      return;
    }
    case "agent-config": {
      const action = rest[0] ?? "list";
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const ids = rest.slice(1).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--path" && all[index - 1] !== "--note" && all[index - 1] !== "--reviewer");
      const option = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
      try {
        if (action === "snapshot") {
          const version = await captureAgentConfigVersion(target, { note: option("--note") ?? "", createdBy: option("--author") ?? "local-user" });
          process.stdout.write(formatAgentConfigVersion(version) + "\\n");
        } else if (action === "list") {
          const versions = await listAgentConfigVersions(target);
          process.stdout.write(versions.length ? versions.map(item => item.id + "  " + item.status.padEnd(9) + "  " + item.createdAt + "  " + item.files.length + " files").join("\\n") + "\\n" : "No agent configuration snapshots found. Run forge agent-config snapshot first.\\n");
        } else if (action === "show") {
          const id = ids[0]; if (!id) throw new Error("Usage: forge agent-config show CONFIG_ID --path PROJECT");
          process.stdout.write(formatAgentConfigVersion(await loadAgentConfigVersion(target, id)) + "\\n");
        } else if (action === "diff") {
          if (ids.length < 2) throw new Error("Usage: forge agent-config diff BEFORE_ID AFTER_ID --path PROJECT");
          const [before, after] = await Promise.all([loadAgentConfigVersion(target, ids[0]!), loadAgentConfigVersion(target, ids[1]!)]);
          const diff = compareAgentConfigVersions(before, after);
          process.stdout.write(["Agent configuration diff", "Added: " + (diff.added.join(", ") || "none"), "Changed: " + (diff.changed.join(", ") || "none"), "Removed: " + (diff.removed.join(", ") || "none"), "Unchanged: " + diff.unchanged.length].join("\\n") + "\\n");
        } else if (action === "approve") {
          throw new Error("Direct snapshot approval is disabled. Use forge agent-release prepare with a release-ready benchmark matrix, then forge agent-release approve RELEASE_ID --reviewer NAME.");
        } else throw new Error("Unknown action. Use snapshot, list, show or diff.");
      } catch (error) {
        process.stderr.write("FORGE agent configuration command failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "experiment-history": {
      const option = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const rawLimit = option("--limit");
      const limit = rawLimit === undefined ? undefined : Number(rawLimit);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
        process.stderr.write("FORGE experiment history: --limit must be an integer from 1 to 100.\\n");
        process.exitCode = 1; return;
      }
      try {
        const suiteId = option("--suite");
        const candidateId = option("--candidate");
        const reports = await listBenchmarkMatrices(target);
        const history = buildExperimentHistory(reports, { ...(suiteId ? { suiteId } : {}), ...(candidateId ? { candidateId } : {}), ...(limit !== undefined ? { limit } : {}) });
        process.stdout.write(rest.includes("--json") ? JSON.stringify(history, null, 2) + "\\n" : formatExperimentHistory(history) + "\\n");
      } catch (error) {
        process.stderr.write("FORGE experiment history failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "experiment-studio": {
      const action = rest[0] ?? "create";
      const option = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
      if (action !== "create" && action !== "compare") {
        process.stderr.write("Usage: forge experiment-studio compare --id ID --name NAME --candidates id:provider:model,id:provider:model [--config-versions id=cfg-id,id=cfg-id] [--repeats 2] [--path PROJECT]\\n");
        process.stderr.write("   or: forge experiment-studio create --id ID --name NAME --provider PROVIDER --model MODEL --skills skill-a,skill-b [--repeats 2] [--path PROJECT]\\n");
        process.exitCode = 1;
        return;
      }
      const id = option("--id");
      const name = option("--name");
      if (action === "compare") {
        const rawCandidates = option("--candidates");
        const repeats = Number(option("--repeats") ?? "2");
        const pathIndex = rest.indexOf("--path");
        const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
        if (!id || !name || !rawCandidates) {
          process.stderr.write("Usage: forge experiment-studio compare --id ID --name NAME --candidates id:provider:model,id:provider:model [--repeats 2] [--path PROJECT]\\n");
          process.exitCode = 1; return;
        }
        try {
          const configVersions = new Map((option("--config-versions") ?? "").split(",").filter(Boolean).map(item => {
          const separator = item.indexOf("=");
          if (separator < 1 || separator === item.length - 1) throw new Error("Each config version must use candidate-id=cfg-xxxxxxxxxxxx format.");
          return [item.slice(0, separator), item.slice(separator + 1)] as const;
        }));
        const candidates = rawCandidates.split(",").map(item => {
            const [candidateId, candidateProvider, ...modelParts] = item.split(":");
            const model = modelParts.join(":");
            if (!candidateId || !candidateProvider || !model) throw new Error("Each candidate must use id:provider:model format.");
            if (!["openai", "claude-code", "anthropic", "google", "ollama"].includes(candidateProvider)) throw new Error("Unsupported candidate provider: " + candidateProvider);
            const configVersionId = configVersions.get(candidateId);
            return { id: candidateId, provider: candidateProvider as "openai" | "claude-code" | "anthropic" | "google" | "ollama", model, ...(configVersionId ? { configVersionId } : {}) };
          });
        for (const candidateId of configVersions.keys()) if (!candidates.some(candidate => candidate.id === candidateId)) throw new Error("Configuration snapshot references unknown candidate: " + candidateId);
        for (const candidate of candidates) if (candidate.configVersionId) await loadAgentConfigVersion(target, candidate.configVersionId);
          const matrix = createModelComparisonMatrix({ id, name, repeats, candidates });
          const destination = path.join(target, ".forge", "experiments", id + ".json");
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await writeFile(destination, JSON.stringify(matrix, null, 2) + "\\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
          process.stdout.write(formatModelComparisonMatrix(matrix) + "\\nSaved: " + path.relative(target, destination) + "\\n");
        } catch (error) {
          process.stderr.write("FORGE model comparison failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
          process.exitCode = 1;
        }
        return;
      }
      const provider = option("--provider") ?? "openai";
      const model = option("--model");
      const skills = option("--skills");
      const repeats = Number(option("--repeats") ?? "2");
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      if (!id || !name || !model || !skills) {
        process.stderr.write("Usage: forge experiment-studio create --id ID --name NAME --provider openai|claude-code --model MODEL --skills skill-a,skill-b [--repeats 2] [--path PROJECT]\\n");
        process.exitCode = 1;
        return;
      }
      if (!["openai", "claude-code", "anthropic", "google", "ollama"].includes(provider)) {
        process.stderr.write("Unsupported provider. Choose openai, claude-code, anthropic, google or ollama.\\n"); process.exitCode = 1; return;
      }
      try {
        const skillIds = skills.split(",").map(item => item.trim()).filter(Boolean);
        const matrix = createSkillExperimentMatrix({ id, name, baselineCandidateId: "baseline", treatmentCandidateId: "treatment", provider: provider as "openai" | "claude-code" | "anthropic" | "google" | "ollama", model, repeats, skillIds });
        const registry = await loadSkillRegistry(target);
        const unknown = skillIds.filter(skillId => !registry.some(skill => skill.id === skillId));
        if (unknown.length) throw new Error("Unknown workspace/built-in skill(s): " + unknown.join(", "));
        const destination = path.join(target, ".forge", "experiments", id + ".json");
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, JSON.stringify(matrix, null, 2) + "\\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
        process.stdout.write(formatSkillExperimentMatrix(matrix) + "\\nSaved: " + path.relative(target, destination) + "\\n");
      } catch (error) {
        process.stderr.write("FORGE experiment studio failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "agent-evolution": {
      const matrixId = rest[0];
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      if (!matrixId || matrixId.startsWith("--")) {
        process.stderr.write("Usage: forge agent-evolution MATRIX_ID --path PROJECT\\n");
        process.exitCode = 1;
        return;
      }
      try {
        const history = await listBenchmarkMatrices(target);
        const report = history.filter(item => item.matrixId === matrixId).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!report) throw new Error("Benchmark matrix not found: " + matrixId);
        const assessment = assessAgentEvolution(report);
        process.stdout.write(formatAgentEvolutionAssessment(assessment) + "\\n");
        if (assessment.status !== "eligible-for-review") process.exitCode = assessment.status === "insufficient-evidence" ? 2 : 1;
      } catch (error) {
        process.stderr.write("FORGE agent evolution failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "agent-intelligence": {
      const option = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const rawLimit = option("--limit");
      const limit = rawLimit === undefined ? undefined : Number(rawLimit);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 2 || limit > 50)) {
        process.stderr.write("FORGE agent intelligence: --limit must be an integer from 2 to 50.\\n");
        process.exitCode = 1;
        return;
      }
      try {
        const history = await listBenchmarkMatrices(target);
        const suiteId = option("--suite");
        const candidateId = option("--candidate");
        const report = buildAgentEvaluationIntelligence(history, {
          ...(suiteId ? { suiteId } : {}),
          ...(candidateId ? { candidateId } : {}),
          ...(limit !== undefined ? { limit } : {})
        });
        process.stdout.write(formatAgentEvaluationIntelligence(report) + "\\n");
        if (report.status === "insufficient-data") process.exitCode = 2;
      } catch (error) {
        process.stderr.write("FORGE agent intelligence failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "optimize-agents": {
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      try {
        const matrices = await listBenchmarkMatrices(target);
        const plan = buildAgentOptimizationPlan(matrices);
        process.stdout.write(formatAgentOptimizationPlan(plan) + "\n");
        if (plan.status === "insufficient-history") process.exitCode = 2;
      } catch (error) {
        process.stderr.write("FORGE adaptive agent optimization failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "benchmark-regression": {
      const targetIndex = rest.indexOf("--path");
      const target = path.resolve(targetIndex >= 0 ? rest[targetIndex + 1] ?? "." : ".");
      const matrixId = rest.find((arg, index) => !arg.startsWith("--") && index === 0);
      try {
        const report = await loadBenchmarkRegression(target, matrixId);
        process.stdout.write(formatBenchmarkRegression(report) + "\n");
        if (report.status === "blocked") process.exitCode = 2;
      } catch (error) {
        process.stderr.write("FORGE benchmark regression failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
        process.exitCode = 1;
      }
      return;
    }
    case "experiment": {
      const action = rest[0] ?? "capture";
      const option = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      try {
        if (action === "capture") {
          const matrixFile = option("--matrix-file");
          const suiteId = option("--suite");
          const matrixId = option("--matrix-id");
          const provider = option("--provider") ?? process.env.FORGE_AI_PROVIDER ?? "openai";
          const model = option("--model") ?? process.env.FORGE_AI_MODEL ?? process.env.FORGE_MODEL ?? "gpt-4.1";
          if (!matrixFile || !suiteId || !matrixId) throw new Error("Usage: forge experiment capture --matrix-file CONFIG.json --matrix-id ID --suite SUITE_ID [--provider ID] [--model NAME] [--path PROJECT]");
          const matrix = await loadBenchmarkMatrix(path.resolve(matrixFile));
          const suites = await loadEvaluationSuites(target);
          const suite = suites.find(item => item.id === suiteId);
          if (!suite) throw new Error("Evaluation suite not found: " + suiteId);
          const fingerprints = [];
          for (const candidate of matrix.candidates) {
            if (!candidate.configVersionId) continue;
            const snapshot = await loadAgentConfigVersion(target, candidate.configVersionId);
            fingerprints.push({ candidateId: candidate.id, configVersionId: snapshot.id, fingerprint: fingerprintAgentConfig(snapshot.files) });
          }
          const manifest = await captureExperimentManifest({ projectPath: target, matrixFile: path.resolve(matrixFile), matrixId, suiteId, suite, provider, model, ...(process.env.FORGE_BASE_URL ? { baseUrl: process.env.FORGE_BASE_URL } : {}), agentConfigFingerprints: fingerprints });
          const saved = await saveExperimentManifest(target, manifest);
          process.stdout.write(formatExperimentManifest(manifest) + "\\nSaved: " + path.relative(target, saved) + "\\n");
        } else if (action === "show") {
          const id = rest[1]; if (!id) throw new Error("Usage: forge experiment show EXPERIMENT_ID --path PROJECT");
          process.stdout.write(formatExperimentManifest(await loadExperimentManifest(target, id)) + "\\n");
        } else if (action === "compare") {
          const ids = rest.slice(1).filter((arg,index,all) => !arg.startsWith("--") && all[index-1] !== "--path");
          if (ids.length !== 2) throw new Error("Usage: forge experiment compare EXPERIMENT_A EXPERIMENT_B --path PROJECT");
          const [a,b] = await Promise.all([loadExperimentManifest(target,ids[0]!),loadExperimentManifest(target,ids[1]!)]);
          const comparison = compareExperimentManifests(a,b);
          process.stdout.write("Experiment reproducibility: " + (comparison.compatible ? "COMPATIBLE" : "NOT COMPARABLE") + "\\n" + (comparison.differences.length ? comparison.differences.map(item => "  - " + item).join("\\n") : "  Critical manifest fields match.") + "\\n");
          if (!comparison.compatible) process.exitCode = 2;
        } else throw new Error("Unknown action. Use capture, show or compare.");
      } catch (error) {
        process.stderr.write("FORGE experiment command failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "benchmark-matrix": {
      const configFile = rest.find(arg => !arg.startsWith("--"));
      const suiteIndex = rest.indexOf("--suite"), goalIndex = rest.indexOf("--goal"), pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const suiteId = suiteIndex >= 0 ? rest[suiteIndex + 1] : undefined;
      const goalEnd = goalIndex >= 0 ? rest.findIndex((arg, index) => index > goalIndex && arg.startsWith("--")) : -1;
      const goal = goalIndex >= 0 ? rest.slice(goalIndex + 1, goalEnd >= 0 ? goalEnd : rest.length).join(" ").trim() : "";
      if (!configFile || !suiteId || !goal) { process.stderr.write("Usage: forge benchmark-matrix CONFIG.json --suite SUITE_ID --goal \"engineering task\" [--path PROJECT]\n"); process.exitCode = 1; return; }
      try {
        const config = await loadBenchmarkMatrix(path.resolve(configFile));
        const configVersions = new Map<string, { id: string; fingerprint: string }>();
        for (const candidate of config.candidates) {
          if (!candidate.configVersionId) continue;
          const snapshot = await loadAgentConfigVersion(target, candidate.configVersionId);
          configVersions.set(candidate.id, { id: snapshot.id, fingerprint: fingerprintAgentConfig(snapshot.files) });
        }
        const suites = await loadEvaluationSuites(target);
        const suite = suites.find(item => item.id === suiteId);
        if (!suite) throw new Error("Evaluation suite not found: " + suiteId);
        const apiKey = process.env.FORGE_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
        const baseUrl = process.env.FORGE_BASE_URL ?? "https://api.openai.com/v1";
        const report = await executeBenchmarkMatrix(config, async (candidate, _repeat) => {
          
          const createProvider = (selectedModel: string) => candidate.provider === "claude-code"
            ? new ClaudeCodeProvider({ cwd: target, model: selectedModel })
            : createHostedAgentProvider({ ...process.env, FORGE_AI_PROVIDER: candidate.provider, ...(apiKey ? { FORGE_API_KEY: apiKey } : {}), ...(process.env.FORGE_BASE_URL ? { FORGE_BASE_URL: process.env.FORGE_BASE_URL } : {}) }, selectedModel);
          const router = new ModelRouter({
            fastModel: candidate.model, balancedModel: candidate.model, reasoningModel: candidate.model,
            retryAttempts: Number(process.env.FORGE_MODEL_RETRY_ATTEMPTS ?? 2),
            retryDelayMs: Number(process.env.FORGE_MODEL_RETRY_DELAY_MS ?? 500),
            ...(process.env.FORGE_MAX_INPUT_TOKENS_PER_TASK ? { maxInputTokensPerTask: Number(process.env.FORGE_MAX_INPUT_TOKENS_PER_TASK) } : {}),
            ...(process.env.FORGE_MAX_OUTPUT_TOKENS_PER_TASK ? { maxOutputTokensPerTask: Number(process.env.FORGE_MAX_OUTPUT_TOKENS_PER_TASK) } : {}),
            ...(process.env.FORGE_MAX_ESTIMATED_TOKENS_PER_RUN ? { maxEstimatedTokensPerRun: Number(process.env.FORGE_MAX_ESTIMATED_TOKENS_PER_RUN) } : {}),
            ...(process.env.FORGE_MAX_ESTIMATED_TOKENS_PER_AGENT ? { maxEstimatedTokensPerAgent: readAgentTokenBudgets()! } : {}),
            ...(process.env.FORGE_MAX_TASK_DURATION_MS ? { maxTaskDurationMs: Number(process.env.FORGE_MAX_TASK_DURATION_MS) } : {}),
            ...(process.env.FORGE_MAX_TASK_DURATION_MS_BY_AGENT ? { maxTaskDurationMsByAgent: readAgentDurationBudgets()! } : {}),
            createProvider,
          });
          const configWorkspace = await mkdtemp(path.join(os.tmpdir(), "forge-candidate-config-"));
          try {
            const snapshotId = candidate.configVersionId;
            const snapshot = snapshotId ? await materializeAgentConfigVersion(target, snapshotId, configWorkspace) : undefined;
            if (snapshotId && !snapshot?.files.some(file => file.path === "hooks.json")) {
              throw new Error("Configuration snapshot " + snapshotId + " predates policy-hook isolation. Capture a new snapshot before benchmarking this candidate.");
            }
            const configRoot = snapshotId ? configWorkspace : target;
            const run = createReviewPlan(goal);
            const skillRegistry = await loadSkillRegistry(configRoot);
            const agentRegistry = await loadAgentRegistry(configRoot);
            const requestedSkillIds = candidate.skillIds;
            const unknownSkills = (requestedSkillIds ?? []).filter(id => !skillRegistry.some(skill => skill.id === id));
            if (unknownSkills.length) throw new Error("Candidate " + candidate.id + " references unknown skill(s): " + unknownSkills.join(", "));
            const selectedSkillsForTask = (task: { agent: string; title: string; prompt: string }) => requestedSkillIds === undefined ? selectSkills(skillRegistry, task.agent + " " + task.title + " " + task.prompt) : skillRegistry.filter(skill => requestedSkillIds.includes(skill.id));
            const agentGuidanceForTask = (task: { agent: string }) => agentRegistry.find(agent => agent.id === task.agent)?.instructions ?? "";
            const permissions = await loadPermissionPolicy(configRoot);
            if (permissions.mode !== "proposal-only" || permissions.allowedTools.length > 0) throw new Error("Benchmark candidate " + candidate.id + " requests unsupported tool permissions. FORGE currently enforces proposal-only execution with no enabled tools.");
            const hooks = await loadHooks(configRoot);
            for (const record of run.tasks) {
              const applied = applyBeforeAgentHooks(record.task, hooks);
              record.task = { ...applied.task, prompt: applied.context.length ? applied.task.prompt + "\n\nHook guidance:\n" + applied.context.join("\n") : applied.task.prompt };
              if (applied.blockedReason) { record.status = "blocked"; record.error = "Blocked by policy hook: " + applied.blockedReason; }
            }
            const memory = await buildProjectMemoryContext(target, goal);
            const projectContext = memory.text;
            const started = Date.now();
            const completed = await advanceRun(run, router, new Set(), { maxConcurrency: 4, projectContext, projectContextForTask: async task => [agentGuidanceForTask(task), formatSkillContext(selectedSkillsForTask(task)), await buildAgentWorkspaceContext(target, task)].filter(Boolean).join("\n\n") });
            const durationMs = Date.now() - started;
            await saveRun(target, completed);
            await saveExecutionTrace(target, completed.id, router.traces);
            const evaluation = evaluateRun(completed, suite);
            await saveEvaluationReport(target, evaluation);
            return {
              runId: completed.id, score: evaluation.score, passed: evaluation.passed,
              durationMs,
              estimatedTokens: router.traces.reduce((sum, item) => sum + item.inputTokensEstimate + item.outputTokensEstimate, 0),
              agentScores: evaluation.cases.filter(item => item.status === "scored").map(item => { const task = completed.tasks.find(record => record.task.id === item.taskId)?.task; const appliedSkills = task ? selectedSkillsForTask(task) : []; return { agent: item.agent, caseId: item.caseId, score: item.score, passed: item.passed, skillIds: appliedSkills.map(skill => skill.id), failedCriteria: item.criteria.filter(criterion => !criterion.passed).map(criterion => ({ id: criterion.id, failedChecks: criterion.checks.filter(check => !check.passed).map(check => check.rule + ": " + check.detail) })) }; }),
            };
          } finally {
            await rm(configWorkspace, { recursive: true, force: true });
          }
        });
        report.suiteId = suite.id;
        report.goal = goal;
        if (configVersions.size) report.candidateProvenance = [...configVersions.entries()].map(([candidateId, item]) => ({ candidateId, configVersionId: item.id, fingerprint: item.fingerprint }));
        const experimentManifest = await captureExperimentManifest({
          projectPath: target, matrixFile: path.resolve(configFile), matrixId: config.id, suiteId: suite.id, suite,
          provider: "matrix", model: "candidate-specific",
          ...(process.env.FORGE_BASE_URL ? { baseUrl: process.env.FORGE_BASE_URL } : {}),
          agentConfigFingerprints: report.candidateProvenance ?? []
        });
        const manifestPath = await saveExperimentManifest(target, experimentManifest);
        report.experimentManifest = { id: experimentManifest.id, fingerprint: experimentManifest.fingerprint };
        const saved = await saveBenchmarkMatrix(target, report);
        process.stdout.write("Experiment manifest: " + experimentManifest.id + " · sha256:" + experimentManifest.fingerprint + "\\nManifest saved: " + path.relative(target, manifestPath) + "\\n");
        process.stdout.write(formatBenchmarkMatrix(report) + "\nSaved: " + path.relative(target, saved) + "\n");
        if (report.results.some(item => item.status === "failed") || report.results.some(item => !item.passed)) process.exitCode = 2;
      } catch (error) { process.stderr.write("FORGE benchmark matrix failed: " + (error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
      return;
    }
    case "benchmark": {
      const pathIndex = rest.indexOf("--path"), suiteIndex = rest.indexOf("--suite");
      const runId = rest.find((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--path" && rest[index - 1] !== "--suite");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const suiteId = suiteIndex >= 0 ? rest[suiteIndex + 1] : undefined;
      try {
        if (!runId) {
          const documents = await listBenchmarks(target);
          process.stdout.write(documents.length ? documents.map(document => formatBenchmark(document)).join("\n\n") + "\n" : "No benchmark history. Evaluate and record a run with: forge benchmark RUN_ID --path .\n");
          return;
        }
        const report = await loadEvaluationReport(target, runId, suiteId);
        const trace = await loadExecutionTrace(target, runId);
        const document = await recordBenchmarkTrial(target, createBenchmarkTrial(report, trace));
        process.stdout.write(formatBenchmark(document) + "\n");
      } catch (error) { process.stderr.write("FORGE benchmark failed: " + (error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
      return;
    }
    case "evaluate": {
      const runId = rest.find(arg => !arg.startsWith("--"));
      const pathIndex = rest.indexOf("--path"), suiteIndex = rest.indexOf("--suite");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const suiteId = suiteIndex >= 0 ? rest[suiteIndex + 1] : undefined;
      if (!runId) { process.stderr.write("Usage: forge evaluate RUNID [--suite SUITE_ID] [--path PROJECT]\n"); process.exitCode = 1; return; }
      try {
        const suites = await loadEvaluationSuites(target);
        const suite = suiteId ? suites.find(item => item.id === suiteId) : suites[0];
        if (!suite) throw new Error(suiteId ? "Evaluation suite not found: " + suiteId : "No evaluation suite found. Add one under .forge/evals/.");
        const run = await loadRun(target, runId);
        const judgeEnabled = rest.includes("--judge");
        let report: EvaluationReport | JudgedEvaluationReport;
        if (judgeEnabled) {
          const providerChoice = process.env.FORGE_AI_PROVIDER ?? "openai";
          const model = process.env.FORGE_EVAL_JUDGE_MODEL ?? process.env.FORGE_AI_MODEL ?? process.env.FORGE_MODEL ?? (providerChoice === "claude-code" ? "sonnet" : "gpt-4.1");
          const apiKey = process.env.FORGE_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
          const baseUrl = process.env.FORGE_BASE_URL ?? "https://api.openai.com/v1";
          if (providerChoice !== "claude-code" && !apiKey) throw new Error("Set FORGE_API_KEY or OPENAI_API_KEY to use model-judged evaluation.");
          const judgeProvider = providerChoice === "claude-code" ? new ClaudeCodeProvider({ cwd: target, model }) : new OpenAICompatibleProvider({ apiKey, model, baseUrl });
          report = await evaluateRunWithJudge(run, suite, judgeProvider);
        } else report = evaluateRun(run, suite);
        const reportPath = await saveEvaluationReport(target, report);
        process.stdout.write(formatEvaluationReport(report) + "\n");
        if ("judgedCases" in report) {
          process.stdout.write("Model judge: " + report.judge.provider + (report.judge.model ? " / " + report.judge.model : "") + " · " + report.judge.evaluatedCases + " cases\n");
          for (const item of report.judgedCases) process.stdout.write("  " + item.caseId + " · " + item.result.score + "/100 · " + item.result.rationale + "\n");
        }
        process.stdout.write("Saved: " + reportPath + "\n");
        if (!report.passed || ("judge" in report && !report.judge.passed)) process.exitCode = 2;
      } catch (error) { process.stderr.write("FORGE evaluation failed: " + (error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
      return;
    }
    case "agents": {
      const target = rest.find(arg => !arg.startsWith("--")) ?? ".";
      try {
        const agents = await loadAgentRegistry(path.resolve(target));
        process.stdout.write("FORGE agent registry\n\n");
        for (const agent of agents) {
          process.stdout.write(`  ${agent.id.padEnd(20)} ${agent.name} [${agent.source}]\n    ${agent.description}\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE could not load agents: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "skills": {
      const option = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
      const target = path.resolve(rest.find(arg => !arg.startsWith("--") && arg !== option("--show") && arg !== option("--match")) ?? ".");
      try {
        const skills = await loadSkillRegistry(target);
        const showId = option("--show");
        const matchGoal = option("--match");
        if (showId) {
          const skill = skills.find(item => item.id === showId);
          if (!skill) throw new Error("Skill not found: " + showId);
          process.stdout.write((rest.includes("--json") ? JSON.stringify(skill, null, 2) : formatSkillContext([skill])) + "\n");
        } else if (matchGoal !== undefined) {
          const selected = selectSkills(skills, matchGoal);
          process.stdout.write(rest.includes("--json") ? JSON.stringify(selected, null, 2) + "\n" :
            selected.length ? selected.map(skill => skill.id + "  " + skill.name + " — " + skill.description).join("\n") + "\n" : "No skills matched that goal.\n");
        } else if (rest.includes("--json")) {
          process.stdout.write(JSON.stringify(skills, null, 2) + "\n");
        } else {
          process.stdout.write("FORGE skill registry (" + skills.length + ")\n\n");
          for (const skill of skills) process.stdout.write("  " + skill.id.padEnd(24) + " " + skill.name + " [" + skill.source + "]\n    " + skill.description + "\n");
          process.stdout.write("\nUse --show ID to inspect instructions or --match \"GOAL\" to preview task selection.\n");
        }
      } catch (error) {
        process.stderr.write("Could not load skills: " + (error instanceof Error ? error.message : String(error)) + "\n");
        process.exitCode = 1;
      }
      return;
    }
    case "agent-security": {
      const target = path.resolve(rest.find(arg => !arg.startsWith("--")) ?? ".");
      try {
        const report = await auditAgentConfiguration(target);
        process.stdout.write(rest.includes("--json")
          ? JSON.stringify(report, null, 2) + "\\n"
          : formatAgentSecurityReport(report) + "\\n");
        if (report.summary.critical > 0) process.exitCode = 2;
      } catch (error) {
        process.stderr.write("FORGE agent security audit failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "hooks": {
      const target = path.resolve(rest.find(arg => !arg.startsWith("--")) ?? ".");
      try {
        const hooks = await loadHooks(target);
        process.stdout.write(hooks.length ? hooks.map(hook => hook.id + " [" + hook.event + "] " + hook.action + ": " + hook.message).join("\n") + "\n" : "No lifecycle hooks configured.\n");
      } catch (error) {
        process.stderr.write("Could not load hooks: " + (error instanceof Error ? error.message : String(error)) + "\n");
        process.exitCode = 1;
      }
      return;
    }
    case "memory": {
      const [action = "list", ...memoryArgs] = rest;
      const targetIndex = memoryArgs.findIndex(arg => !arg.startsWith("--"));
      const target = path.resolve(targetIndex >= 0 ? memoryArgs[targetIndex] ?? "." : ".");
      const option = (name: string) => { const index = memoryArgs.indexOf(name); return index >= 0 ? memoryArgs[index + 1] : undefined; };
      try {
        if (action === "list") {
          const entries = await listProjectMemory(target);
          process.stdout.write(entries.length ? entries.map(entry => `${entry.id} [${entry.kind}] ${entry.content}`).join("\n") + "\n" : "No project memory entries.\n");
        } else if (action === "add") {
          const kind = option("--kind") as ProjectMemoryKind | undefined;
          const content = option("--content");
          const allowed: ProjectMemoryKind[] = ["decision", "architecture", "constraint", "preference", "fact"];
          if (!kind || !allowed.includes(kind) || !content) throw new Error("Usage: forge memory add [path] --kind decision|architecture|constraint|preference|fact --content TEXT [--tags a,b]");
          const tags = option("--tags")?.split(",") ?? [];
          const entry = await addProjectMemory(target, { kind, content, tags });
          process.stdout.write(`Saved ${entry.id} to .forge/memory.json\n`);
        } else if (action === "remove") {
          const id = memoryArgs.find(arg => arg.startsWith("mem-"));
          if (!id) throw new Error("Usage: forge memory remove [path] mem-ID");
          const removed = await removeProjectMemory(target, id);
          process.stdout.write(removed ? `Removed ${id}.\n` : `Memory entry ${id} was not found.\n`);
        } else if (action === "context") {
          const query = option("--query") ?? "";
          const context = await buildProjectMemoryContext(target, query);
          process.stdout.write(context.text || "No relevant project memory.\n");
        } else {
          throw new Error("Memory actions: add, list, remove, context.");
        }
      } catch (error) {
        process.stderr.write("FORGE memory command failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
        process.exitCode = 1;
      }
      return;
    }
    case "plan": {
      const goalIndex = rest.indexOf("--goal");
      const pathIndex = rest.indexOf("--path");
      const goalEnd = pathIndex >= 0 ? pathIndex : rest.length;
      const goal = goalIndex >= 0 ? rest.slice(goalIndex + 1, goalEnd).join(" ").trim() : "";
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      try {
        const plan = createReviewPlan(goal);
        const saved = await saveRun(target, plan);
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        process.stdout.write(`\nDraft plan saved to ${path.relative(target, saved)}. No AI provider was called and no files or commands were executed.\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE could not create a plan: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "replay": {
      const runId = rest[0] ?? "";
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      try {
        if (!runId) throw new Error("Usage: forge replay RUN_ID [--path PROJECT]");
        const source = await loadRun(target, runId);
        const replay = createReplayRun(source);
        const saved = await saveRun(target, replay);
        process.stdout.write("Created replay " + replay.id + " from " + runId + ".\n");
        process.stdout.write("Saved: " + path.relative(target, saved) + "\n");
        process.stdout.write("Run `forge resume " + replay.id + " --path " + target + "` when ready to call the configured provider.\n");
      } catch (error) { process.stderr.write("Could not create replay: " + (error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
      return;
    }
    case "approve": {
      const runId = rest[0] ?? "";
      const taskId = rest[1] ?? "";
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const reviewerIndex = rest.indexOf("--reviewer");
      const reasonIndex = rest.indexOf("--reason");
      try {
        if (!runId || !taskId) throw new Error("Usage: forge approve RUN_ID TASK_ID [--reviewer NAME] [--reason TEXT] [--path PROJECT]");
        const updated = await decideTaskApproval(target, runId, taskId, "approved", reviewerIndex >= 0 ? rest[reviewerIndex + 1] ?? "local-user" : "local-user", reasonIndex >= 0 ? rest.slice(reasonIndex + 1, pathIndex >= 0 ? pathIndex : rest.length).join(" ") : undefined);
        process.stdout.write("Approved " + taskId + " in " + runId + ". Resume explicitly with `forge resume " + runId + "`.\n");
        process.stdout.write("Run status: " + updated.status + "\n");
      } catch (error) { process.stderr.write("Could not approve task: " + (error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
      return;
    }
    case "resume": {
      const runId = rest[0] ?? "";
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      try {
        if (!runId) throw new Error("Usage: forge resume RUN_ID [--path PROJECT]");
        const permissions = await loadPermissionPolicy(target);
        const providerChoice = (process.env.FORGE_AI_PROVIDER ?? "openai").toLowerCase();
        assertSupportedAgentPolicy(permissions, providerChoice, "FORGE resume");
        await withRunExecutionLock(target, runId, async () => {
        const savedRun = await loadRun(target, runId);
        if (savedRun.status === "running") {
          const recovered = await recoverInterruptedRun(target, runId);
          process.stdout.write("Recovered interrupted run " + runId + ": " + recovered.status + "\\n");
          process.stdout.write("Any task that was running has an unknown provider outcome and was marked failed. FORGE did not replay provider requests. Review the run before explicitly retrying failed work.\\n");
          return;
        }
        if (savedRun.status !== "pending" && savedRun.status !== "awaiting_approval") throw new Error("Only pending or approval-cleared runs can be resumed. Use `forge replay` only after reviewing failed tasks.");
        const model = process.env.FORGE_AI_MODEL ?? process.env.FORGE_MODEL;
        const baseModel = model ?? (providerChoice === "claude-code" ? "sonnet" : "gpt-4.1-mini");
        const createProvider = (selectedModel: string) => providerChoice === "claude-code" ? new ClaudeCodeProvider({ cwd: target, model: selectedModel }) : createHostedAgentProvider({ ...process.env, FORGE_AI_PROVIDER: providerChoice }, selectedModel, { workspacePath: target, permissionPolicy: permissions });
        let priorTraceEntries: Awaited<ReturnType<typeof loadExecutionTrace>>["entries"] = [];
        try { priorTraceEntries = (await loadExecutionTrace(target, runId)).entries; }
        catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
        const traceAgentUsage = priorTraceEntries.reduce<Record<string, number>>((usage, entry) => { usage[entry.agent] = (usage[entry.agent] ?? 0) + entry.inputTokensEstimate + entry.outputTokensEstimate; return usage; }, {});
        const traceRunUsage = priorTraceEntries.reduce((total, entry) => total + entry.inputTokensEstimate + entry.outputTokensEstimate, 0);
        const priorAgentUsage = savedRun.tokenUsage?.estimatedTokensByAgent ?? traceAgentUsage;
        const priorRunUsage = savedRun.tokenUsage?.estimatedTokensUsed ?? traceRunUsage;
        const router = new ModelRouter({ fastModel: process.env.FORGE_MODEL_FAST ?? baseModel, balancedModel: process.env.FORGE_MODEL_BALANCED ?? baseModel, reasoningModel: process.env.FORGE_MODEL_REASONING ?? baseModel, ...(process.env.FORGE_FALLBACK_MODEL ? { fallbackModel: process.env.FORGE_FALLBACK_MODEL } : {}), retryAttempts: Number(process.env.FORGE_MODEL_RETRY_ATTEMPTS ?? 2), retryDelayMs: Number(process.env.FORGE_MODEL_RETRY_DELAY_MS ?? 500), ...(process.env.FORGE_MAX_INPUT_TOKENS_PER_TASK ? { maxInputTokensPerTask: Number(process.env.FORGE_MAX_INPUT_TOKENS_PER_TASK) } : {}), ...(process.env.FORGE_MAX_OUTPUT_TOKENS_PER_TASK ? { maxOutputTokensPerTask: Number(process.env.FORGE_MAX_OUTPUT_TOKENS_PER_TASK) } : {}), ...(process.env.FORGE_MAX_ESTIMATED_TOKENS_PER_RUN ? { maxEstimatedTokensPerRun: Number(process.env.FORGE_MAX_ESTIMATED_TOKENS_PER_RUN) } : {}),
          ...(process.env.FORGE_MAX_ESTIMATED_TOKENS_PER_AGENT ? { maxEstimatedTokensPerAgent: readAgentTokenBudgets()! } : {}),
          ...(process.env.FORGE_MAX_TASK_DURATION_MS ? { maxTaskDurationMs: Number(process.env.FORGE_MAX_TASK_DURATION_MS) } : {}),
          ...(process.env.FORGE_MAX_TASK_DURATION_MS_BY_AGENT ? { maxTaskDurationMsByAgent: readAgentDurationBudgets()! } : {}),
          initialEstimatedTokensUsed: priorRunUsage, initialEstimatedTokensByAgent: priorAgentUsage, createProvider });
        const memory = await buildProjectMemoryContext(target, savedRun.goal);
        // Re-check current workspace policy before resuming any task that has not completed.
        // Previously applied hook guidance is kept in the saved prompt and is not appended twice.
        const resumeHooks = await loadHooks(target);
        for (const record of savedRun.tasks) {
          if (record.status !== "pending" && record.status !== "awaiting_approval") continue;
          const applied = applyBeforeAgentHooks(record.task, resumeHooks);
          const additions = applied.context.filter(message => !record.task.prompt.includes(message));
          record.task = {
            ...applied.task,
            prompt: additions.length ? record.task.prompt + "\n\nHook guidance:\n" + additions.join("\n") : record.task.prompt,
          };
          if (applied.blockedReason) {
            record.status = "blocked";
            record.error = "Blocked by current policy hook: " + applied.blockedReason;
          }
        }
        const currentTokenUsage = () => {
          const usage = router.traces.reduce((total, entry) => { total.estimatedTokensUsed += entry.inputTokensEstimate + entry.outputTokensEstimate; total.estimatedTokensByAgent[entry.agent] = (total.estimatedTokensByAgent[entry.agent] ?? 0) + entry.inputTokensEstimate + entry.outputTokensEstimate; return total; }, { estimatedTokensUsed: priorRunUsage, estimatedTokensByAgent: { ...priorAgentUsage } as Record<string, number> });
          return usage;
        };
        let persistedTraceEntries = 0;
        const persistRunSnapshot = async (snapshot: RunRecord) => {
          await saveRun(target, { ...snapshot, tokenUsage: currentTokenUsage() });
          const newEntries = router.traces.slice(persistedTraceEntries);
          if (newEntries.length) { await saveExecutionTrace(target, snapshot.id, newEntries); persistedTraceEntries = router.traces.length; }
        };
        const completed = await advanceRun(savedRun, router, new Set(), { maxConcurrency: 4, projectContext: memory.text, projectContextForTask: task => buildAgentWorkspaceContext(target, task), shouldCancel: async () => (await loadRun(target, runId)).status === "cancelled", onTaskSettled: persistRunSnapshot, onUpdate: persistRunSnapshot });
        const saved = await saveRun(target, { ...completed, tokenUsage: currentTokenUsage() });
        const tracePath = await saveExecutionTrace(target, completed.id, router.traces.slice(persistedTraceEntries));
        process.stdout.write("Resumed " + runId + ": " + completed.status + "\n");
        process.stdout.write("Saved: " + path.relative(target, saved) + "\nTrace: " + path.relative(target, tracePath) + "\n");
        });
      } catch (error) { process.stderr.write("Could not resume run: " + (error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
      return;
    }
    case "trace": {
      const runId = rest[0];
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      if (!runId) { process.stderr.write("Usage: forge trace RUNID [--path PROJECT]\n"); process.exitCode = 1; return; }
      try {
        const trace = await loadExecutionTrace(target, runId);
        process.stdout.write("FORGE execution trace: " + runId + "\n");
        for (const entry of trace.entries) process.stdout.write("  " + entry.taskId + " [" + entry.tier + "] " + entry.model + " | " + entry.durationMs + " ms | " + entry.outcome + " | ~" + entry.inputTokensEstimate + "/" + entry.outputTokensEstimate + " tokens\n");
        process.stdout.write("Totals: " + trace.totals.tasks + " tasks, " + trace.totals.estimatedInputTokens + " input tokens, " + trace.totals.estimatedOutputTokens + " output tokens, " + trace.totals.fallbacks + " fallbacks, " + trace.totals.failures + " failures\n");
        process.stdout.write("Provider health:\n");
        for (const provider of trace.providers ?? []) process.stdout.write("  " + provider.name + ": " + provider.requests + " requests, " + provider.successes + " successes, " + provider.fallbacks + " fallbacks, " + provider.failures + " failures, " + provider.retries + " retries, " + provider.durationMs + " ms\n");
      } catch (error) { process.stderr.write("Could not read execution trace: " + (error instanceof Error ? error.message : String(error)) + "\n"); process.exitCode = 1; }
      return;
    }
    case "runs": {
      if (rest.includes("--help")) {
        process.stdout.write("Usage: forge runs [path] [--json] [--limit N] [--status STATUS]\nLists valid saved run records. Use --json for the versioned machine-readable summary, --limit N for the newest N runs, and --status to filter by run state.\n");
        return;
      }
      const limitIndex = rest.indexOf("--limit");
      const statusIndex = rest.indexOf("--status");
      const rawLimit = limitIndex >= 0 ? rest[limitIndex + 1] : undefined;
      const rawStatus = statusIndex >= 0 ? rest[statusIndex + 1] : undefined;
      const limit = limitIndex < 0 ? undefined : Number(rawLimit);
      const positionalPaths = rest.filter((arg, index) =>
        !arg.startsWith("--") &&
        !(limitIndex >= 0 && index === limitIndex + 1) &&
        !(statusIndex >= 0 && index === statusIndex + 1)
      );
      const target = positionalPaths[0] ?? ".";
      try {
        if (positionalPaths.length > 1) {
          throw new Error("Usage: forge runs [path] [--json] [--limit N] [--status STATUS]");
        }
        for (const option of ["--json", "--limit", "--status"]) {
          if (rest.filter(arg => arg === option).length > 1) {
            throw new Error(`${option} may only be specified once.`);
          }
        }
        const allowedOptions = new Set(["--json", "--limit", "--status"]);
        const unknownOption = rest.find(arg => arg.startsWith("--") && !allowedOptions.has(arg));
        if (unknownOption) throw new Error(`Unknown option: ${unknownOption}.`);
        if (limitIndex >= 0 && (!rawLimit || rawLimit.startsWith("--") || !Number.isSafeInteger(limit) || limit! < 1)) {
          throw new Error("--limit requires a positive safe integer.");
        }
        const validStatuses = ["pending", "awaiting_approval", "running", "completed", "failed", "cancelled"] as const;
        if (statusIndex >= 0 && (!rawStatus || rawStatus.startsWith("--") || !validStatuses.includes(rawStatus as typeof validStatuses[number]))) {
          throw new Error(`--status requires one of: ${validStatuses.join(", ")}.`);
        }
        const allRuns = await listRuns(path.resolve(target));
        const filteredRuns = rawStatus ? allRuns.filter(run => run.status === rawStatus) : allRuns;
        const runs = limit === undefined ? filteredRuns : filteredRuns.slice(0, limit);
        if (rest.includes("--json")) {
          process.stdout.write(formatRunHistoryJson(runs));
        } else {
          process.stdout.write(runs.length ? runs.map(run => `${run.id}  ${run.status.padEnd(18)} ${run.goal}`).join("\n") + "\n" : "No saved FORGE runs.\n");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Could not list run history: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "show-run": {
      if (rest.includes("--help")) {
        process.stdout.write("Usage: forge show-run RUN_ID [--path PROJECT]\nDisplays one validated saved run record.\n");
        return;
      }
      const pathIndices = rest.flatMap((arg, index) => arg === "--path" ? [index] : []);
      const pathIndex = pathIndices[0] ?? -1;
      const pathValue = pathIndex >= 0 ? rest[pathIndex + 1] : undefined;
      const positional = rest.filter((arg, index) =>
        !arg.startsWith("--") && !(pathIndex >= 0 && index === pathIndex + 1)
      );
      const target = pathValue ?? ".";
      try {
        if (pathIndices.length > 1) throw new Error("--path may only be specified once.");
        if (rest.some(arg => arg.startsWith("--") && arg !== "--path")) {
          throw new Error(`Unknown option: ${rest.find(arg => arg.startsWith("--") && arg !== "--path")}.`);
        }
        if (pathIndex >= 0 && (!pathValue || pathValue.startsWith("--"))) {
          throw new Error("--path requires a project directory.");
        }
        if (positional.length !== 1) throw new Error("Usage: forge show-run RUN_ID [--path PROJECT]");
        const id = positional[0]!;
        const run = await loadRun(path.resolve(target), id);
        process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Could not load run: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "run": {
      const goalIndex = rest.indexOf("--goal");
      const pathIndex = rest.indexOf("--path");
      const goalEnd = pathIndex >= 0 ? pathIndex : rest.length;
      const goal = goalIndex >= 0 ? rest.slice(goalIndex + 1, goalEnd).join(" ").trim() : "";
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      try {
        const permissions = await loadPermissionPolicy(target);
        const model = process.env.FORGE_AI_MODEL ?? process.env.FORGE_MODEL;
        const providerChoice = (process.env.FORGE_AI_PROVIDER ?? "openai").toLowerCase();
        assertSupportedAgentPolicy(permissions, providerChoice, "FORGE run");
        const baseModel = model ?? (providerChoice === "claude-code" ? "sonnet" : "gpt-4.1-mini");
        const apiKey = process.env.FORGE_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
        const baseUrl = process.env.FORGE_BASE_URL ?? "https://api.openai.com/v1";
        const createProvider = (selectedModel: string) => {
          if (providerChoice === "claude-code") return new ClaudeCodeProvider({ cwd: target, model: selectedModel });
          if (["openai", "anthropic", "google", "ollama"].includes(providerChoice)) {
            return createHostedAgentProvider({ ...process.env, FORGE_AI_PROVIDER: providerChoice }, selectedModel, { workspacePath: target, permissionPolicy: permissions });
          }
          throw new Error("Unsupported FORGE_AI_PROVIDER. Choose claude-code, openai, anthropic, google or ollama.");
        };
        const router = new ModelRouter({
          fastModel: process.env.FORGE_MODEL_FAST ?? baseModel,
          balancedModel: process.env.FORGE_MODEL_BALANCED ?? baseModel,
          reasoningModel: process.env.FORGE_MODEL_REASONING ?? baseModel,
          ...(process.env.FORGE_FALLBACK_MODEL ? { fallbackModel: process.env.FORGE_FALLBACK_MODEL } : {}),
          retryAttempts: Number(process.env.FORGE_MODEL_RETRY_ATTEMPTS ?? 2),
          retryDelayMs: Number(process.env.FORGE_MODEL_RETRY_DELAY_MS ?? 500),
          createProvider,
          ...(process.env.FORGE_MAX_INPUT_TOKENS_PER_TASK ? { maxInputTokensPerTask: Number(process.env.FORGE_MAX_INPUT_TOKENS_PER_TASK) } : {}),
          ...(process.env.FORGE_MAX_OUTPUT_TOKENS_PER_TASK ? { maxOutputTokensPerTask: Number(process.env.FORGE_MAX_OUTPUT_TOKENS_PER_TASK) } : {}),
          ...(process.env.FORGE_MAX_ESTIMATED_TOKENS_PER_RUN ? { maxEstimatedTokensPerRun: Number(process.env.FORGE_MAX_ESTIMATED_TOKENS_PER_RUN) } : {}),
          ...(process.env.FORGE_MAX_ESTIMATED_TOKENS_PER_AGENT ? { maxEstimatedTokensPerAgent: readAgentTokenBudgets()! } : {}),
          ...(process.env.FORGE_MAX_TASK_DURATION_MS ? { maxTaskDurationMs: Number(process.env.FORGE_MAX_TASK_DURATION_MS) } : {}),
          ...(process.env.FORGE_MAX_TASK_DURATION_MS_BY_AGENT ? { maxTaskDurationMsByAgent: readAgentDurationBudgets()! } : {}),
        });
        const provider = router;
        const plan = createReviewPlan(goal);
        const skills = selectSkills(await loadSkillRegistry(target), goal);
        const skillContext = formatSkillContext(skills);
        const hooks = await loadHooks(target);
        for (const record of plan.tasks) {
          const applied = applyBeforeAgentHooks(record.task, hooks);
          record.task = { ...applied.task, prompt: applied.context.length ? applied.task.prompt + "\n\nHook guidance:\n" + applied.context.join("\n") : applied.task.prompt };
          if (applied.blockedReason) { record.status = "blocked"; record.error = "Blocked by policy hook: " + applied.blockedReason; }
        }
        process.stdout.write("Starting " + plan.id + " with provider " + provider.name + (model ? " (model " + model + ")" : "") + "\n");
        if (skills.length) process.stdout.write("Selected skills: " + skills.map(skill => skill.id).join(", ") + "\n");
        if (hooks.length) process.stdout.write("Loaded policy hooks: " + hooks.length + "\n");
        const memory = await buildProjectMemoryContext(target, goal);
        const projectContext = [memory.text, skillContext].filter(Boolean).join("\n\n");
        const completed = await advanceRun(plan, provider, new Set(), { maxConcurrency: 4, projectContext, projectContextForTask: task => buildAgentWorkspaceContext(target, task) });
        const saved = await saveRun(target, completed);
        const tracePath = await saveExecutionTrace(target, completed.id, router.traces);
        process.stdout.write(`Run status: ${completed.status}\nSaved history: ${path.relative(target, saved)}\nExecution trace: ${path.relative(target, tracePath)}\n`);
        const totals = router.traces.reduce((sum, trace) => ({ input: sum.input + trace.inputTokensEstimate, output: sum.output + trace.outputTokensEstimate, duration: sum.duration + trace.durationMs, fallback: sum.fallback + (trace.outcome === "fallback" ? 1 : 0) }), { input: 0, output: 0, duration: 0, fallback: 0 });
        process.stdout.write(`Estimated tokens: ${totals.input} in / ${totals.output} out | Agent time: ${totals.duration} ms | Fallbacks: ${totals.fallback}\n`);
        for (const task of completed.tasks) process.stdout.write(`  ${task.status.padEnd(18)} ${task.task.agent}: ${task.task.title}\n`);
        if (completed.status === "failed") process.exitCode = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE run failed: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "deps": {
      if (rest.includes("--help")) {
        process.stdout.write("Usage: forge deps [path] [--audit-report FILE] [--outdated-report FILE] [--json]\n");
        return;
      }
      const option = (name:string) => { const index=rest.indexOf(name); return index>=0 ? rest[index+1] : undefined; };
      const target=path.resolve(rest.find((arg,index)=>!arg.startsWith("--")&&rest[index-1]!=="--audit-report"&&rest[index-1]!=="--outdated-report")??".");
      try {
        const auditReport=option("--audit-report"),outdatedReport=option("--outdated-report");
        const report=await analyzeDependencies(target,{...(auditReport?{auditReport}:{}),...(outdatedReport?{outdatedReport}:{})});
        process.stdout.write(rest.includes("--json")?JSON.stringify(report,null,2)+"\n":formatDependencyIntelligence(report)+"\n");
      } catch(error) {
        process.stderr.write("FORGE dependency analysis failed: "+(error instanceof Error?error.message:String(error))+"\n");
        process.exitCode=1;
      }
      return;
    }
    case "snapshot": {
      const target=path.resolve(rest.find(arg=>!arg.startsWith("--"))??".");
      try { const comparison=await captureIntelligenceSnapshot(target);process.stdout.write(formatIntelligenceComparison(comparison)+"\n"); }
      catch(error){process.stderr.write("FORGE snapshot failed: "+(error instanceof Error?error.message:String(error))+"\n");process.exitCode=1;}
      return;
    }
    case "timeline": {
      const target=path.resolve(rest.find(arg=>!arg.startsWith("--"))??".");
      try { const comparison=await compareLatestIntelligence(target);process.stdout.write(comparison?formatIntelligenceComparison(comparison)+"\n":"No engineering snapshots found. Run forge snapshot . first.\n"); }
      catch(error){process.stderr.write("FORGE timeline failed: "+(error instanceof Error?error.message:String(error))+"\n");process.exitCode=1;}
      return;
    }
    case "change-risk": {
      const pathIndex=rest.indexOf("--path"),baseIndex=rest.indexOf("--base");
      const target=path.resolve(pathIndex>=0?rest[pathIndex+1]??".":rest.find((arg,index)=>!arg.startsWith("--")&&rest[index-1]!=="--base")??".");
      const base=baseIndex>=0?rest[baseIndex+1]??"HEAD":"HEAD";
      const json=rest.includes("--json");
      try { const report=await analyzeChangeIntelligence(target,base);process.stdout.write(json?JSON.stringify(report,null,2)+"\n":formatChangeIntelligence(report)+"\n"); }
      catch(error){process.stderr.write("FORGE change-risk analysis failed: "+(error instanceof Error?error.message:String(error))+"\n");process.exitCode=1;}
      return;
    }
    case "risk": {
      const pathIndex=rest.indexOf("--path");
      const target=path.resolve(pathIndex>=0?rest[pathIndex+1]??".":rest.find(arg=>!arg.startsWith("--"))??".");
      const json=rest.includes("--json");
      try { const report=await analyzeEngineeringRisk(target);process.stdout.write(json?JSON.stringify(report,null,2)+"\n":formatEngineeringRisk(report)+"\n"); }
      catch(error){process.stderr.write("FORGE engineering risk analysis failed: "+(error instanceof Error?error.message:String(error))+"\n");process.exitCode=1;}
      return;
    }
    case "impact": {
      const pathIndex=rest.indexOf("--path"),baseIndex=rest.indexOf("--base");
      const target=path.resolve(pathIndex>=0?rest[pathIndex+1]??".":rest.find((arg,index)=>!arg.startsWith("--")&&rest[index-1]!=="--base")??".");
      const base=baseIndex>=0?rest[baseIndex+1]??"HEAD":"HEAD";
      const json=rest.includes("--json");
      try { const report=await analyzeDependencyImpact(target,base);process.stdout.write(json?JSON.stringify(report,null,2)+"\n":formatDependencyImpact(report)+"\n"); }
      catch(error){process.stderr.write("FORGE dependency impact analysis failed: "+(error instanceof Error?error.message:String(error))+"\n");process.exitCode=1;}
      return;
    }
    case "search": {
      const pathIndex=rest.indexOf("--path"),limitIndex=rest.indexOf("--limit");
      const optionValues=new Set<number>();
      if(pathIndex>=0)optionValues.add(pathIndex+1);
      if(limitIndex>=0)optionValues.add(limitIndex+1);
      const target=path.resolve(pathIndex>=0?rest[pathIndex+1]??".":".");
      const query=rest.filter((arg,index)=>!arg.startsWith("--")&&!optionValues.has(index)).join(" ").trim();
      const limit=limitIndex>=0?Number(rest[limitIndex+1]):80;
      try { const report=await searchWorkspace(target,query,limit);process.stdout.write(JSON.stringify(report,null,2)+"\n"); }
      catch(error){process.stderr.write("FORGE code search failed: "+(error instanceof Error?error.message:String(error))+"\n");process.exitCode=1;}
      return;
    }
    case "dashboard": {
      const target = path.resolve(rest.find(arg => !arg.startsWith("--")) ?? ".");
      const portIndex = rest.indexOf("--port");
      const portValue = portIndex >= 0 ? Number(rest[portIndex + 1]) : 4173;
      if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65535) {
        process.stderr.write("Dashboard port must be an integer from 0 to 65535.\n");
        process.exitCode = 1;
        return;
      }
      try {
        const dashboard = await startDashboard({ projectPath: target, port: portValue });
        const address = dashboard.server.address();
        const actualPort = address && typeof address !== "string" ? address.port : portValue;
        process.stdout.write(`FORGE dashboard: http://127.0.0.1:${actualPort}\nProject: ${target}\nPress Ctrl+C to stop.\n`);
        const shutdown = () => dashboard.server.close(() => process.exit(0));
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Could not start dashboard: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "verify": {
      const listOnly = rest.includes("--list");
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const script = rest.find(arg => !arg.startsWith("--"));
      try {
        if (listOnly) {
          const checks = await discoverChecks(target);
          process.stdout.write(checks.length ? checks.map(check => `${check.name.padEnd(20)} ${check.command}`).join("\n") + "\n" : "No selectable npm scripts found.\n");
          return;
        }
        if (!script) throw new Error("Choose one script explicitly. Usage: forge verify SCRIPT [--path PROJECT], or use --list to discover scripts.");
        const result = await runVerification(target, script);
        const comparison = await compareVerification(target, result);
        await saveVerification(target, result);
        process.stdout.write(`${formatVerificationResult(result)}\n\n${formatVerificationComparison(comparison)}\n`);
        process.stdout.write(`\nSaved verification history: ${path.relative(target, path.join(target, ".forge", "verifications", result.id + ".json"))}\n`);
        if (result.status !== "passed") process.exitCode = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE verification failed: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "sandbox-profiles": {
      const selected = rest[0];
      try {
        const profiles = selected ? [getSandboxSecurityProfile(selected)] : listSandboxSecurityProfiles();
        for (const profile of profiles) {
          process.stdout.write([
            profile.name + " — " + profile.description,
            "  network=" + profile.network + ", readOnlyRoot=" + profile.readOnlyRoot +
              ", dropAllCapabilities=" + profile.dropAllCapabilities +
              ", noNewPrivileges=" + profile.noNewPrivileges,
            "  memory=" + profile.maxMemory + ", cpus=" + profile.maxCpus +
              ", processes=" + profile.maxProcesses +
              ", requireRootless=" + profile.requireRootless,
            "",
          ].join("\\n"));
        }
      } catch (error) {
        process.stderr.write("FORGE sandbox profiles failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "sandbox-cleanup-history": {
      const target = path.resolve(rest[0] ?? ".");
      try {
        process.stdout.write(formatSandboxCleanupHistory(await readSandboxCleanupAudit(target)) + "\\n");
      } catch (error) {
        process.stderr.write("FORGE sandbox cleanup history failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "sandbox-cleanup": {
      const apply = rest.includes("--apply");
      const unknown = rest.filter(arg => arg !== "--apply");
      try {
        if (unknown.length) throw new Error("Usage: forge sandbox-cleanup [--apply]. Cleanup is dry-run unless --apply is explicit.");
        const output = await runSandboxProbe([
          "ps", "-a", "--filter", "label=com.forge.managed=true",
          "--format", "{{.ID}}\\t{{.Status}}\\t{{.Names}}",
        ]);
        const managed = parseManagedContainers(output);
        const candidates = selectStoppedManagedContainers(managed);
        const removed: string[] = [];
        if (apply) {
          for (const container of candidates) {
            await runSandboxProbe(["rm", container.id]);
            removed.push(container.id);
          }
        }
        await appendSandboxCleanupAudit(process.cwd(), {
          id: "cleanup-" + Date.now().toString(36),
          timestamp: new Date().toISOString(),
          mode: apply ? "apply" : "dry-run",
          candidates: candidates.map(({ id, name, status }) => ({ id, name, status })),
          removed,
        });
        process.stdout.write(formatSandboxCleanupReport(candidates, removed, apply) + "\\n");
      } catch (error) {
        process.stderr.write("FORGE sandbox cleanup failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "sandbox-policy-check": {
      const policyPath = rest[0];
      if (!policyPath) { process.stderr.write("Usage: forge sandbox-policy-check POLICY.json\n"); process.exitCode = 1; return; }
      const result = await loadSandboxPolicy(policyPath);
      process.stdout.write(formatSandboxPolicyValidation(result) + "\n");
      if (!result.valid) process.exitCode = 1;
      return;
    }
    case "sandbox-compliance": {
      const profileName = rest[0] ?? "balanced";
      const image = rest[1] ?? "";
      try {
        const profile = getSandboxSecurityProfile(profileName);
        const imageDigestPinned = /^.+@sha256:[a-f0-9]{64}$/.test(image);
        let runtimeAvailable = false;
        let rootless: boolean | null = null;
        try {
          const [version, security] = await Promise.all([
            runSandboxProbe(["--version"]),
            runSandboxProbe(["info", "--format", "{{json .SecurityOptions}}"]),
          ]);
          runtimeAvailable = Boolean(version.trim());
          rootless = detectDockerRootless(security);
        } catch {
          runtimeAvailable = false;
        }
        const report = createSandboxComplianceReport(profile, {
          available: runtimeAvailable,
          rootless,
          imageDigestPinned,
        });
        process.stdout.write(formatSandboxComplianceReport(report) + "\\n");
        if (report.status === "non-compliant") process.exitCode = 1;
      } catch (error) {
        process.stderr.write("FORGE sandbox compliance failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "sandbox-status": {
      const runtime = "docker";
      try {
        const [version, security] = await Promise.all([
          runSandboxProbe(["--version"]),
          runSandboxProbe(["info", "--format", "{{json .SecurityOptions}}"]),
        ]);
        const report = parseSandboxRuntimeReport(runtime, version, security);
        process.stdout.write(formatSandboxRuntimeReport(report) + "\\n");
      } catch (error) {
        const report = parseSandboxRuntimeReport(runtime, "", "");
        report.warnings.push(error instanceof Error ? error.message : String(error));
        process.stdout.write(formatSandboxRuntimeReport(report) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "patch-verify": {
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const installDependencies = rest.includes("--install-dependencies");
      const sandboxImageIndex = rest.indexOf("--sandbox-image");
      const sandboxImage = sandboxImageIndex >= 0 ? rest[sandboxImageIndex + 1] : undefined;
      const requireRootless = rest.includes("--require-rootless");
      const profileIndex = rest.indexOf("--profile");
      const securityProfile = profileIndex >= 0 ? rest[profileIndex + 1] : undefined;
      const policyIndex = rest.indexOf("--policy");
      const sandboxPolicyPath = policyIndex >= 0 ? rest[policyIndex + 1] : undefined;
      const argsWithoutPath = rest.filter((arg, index) => arg !== "--path" && !(pathIndex >= 0 && index === pathIndex + 1) && arg !== "--install-dependencies" && arg !== "--sandbox-image" && !(sandboxImageIndex >= 0 && index === sandboxImageIndex + 1) && arg !== "--require-rootless" && arg !== "--profile" && !(profileIndex >= 0 && index === profileIndex + 1) && arg !== "--policy" && !(policyIndex >= 0 && index === policyIndex + 1));
      const stageId = argsWithoutPath.find(arg => !arg.startsWith("--"));
      const script = argsWithoutPath.find((arg, index) => !arg.startsWith("--") && index > 0);
      try {
        if (!stageId || !script) throw new Error("Usage: forge patch-verify PATCH_STAGE_ID SCRIPT [--install-dependencies] [--sandbox-image IMAGE@sha256:DIGEST] [--require-rootless] [--profile balanced|hardened|rootless-required] [--policy POLICY.json] [--path PROJECT]");
        if (sandboxImageIndex >= 0 && !sandboxImage) throw new Error("--sandbox-image requires an image pinned by sha256 digest.");
        if (requireRootless && !sandboxImage) throw new Error("--require-rootless requires --sandbox-image container execution.");
        if (profileIndex >= 0 && !securityProfile) throw new Error("--profile requires a profile name.");
        if (securityProfile && !["balanced", "hardened", "rootless-required"].includes(securityProfile)) throw new Error("Unknown sandbox security profile: " + securityProfile);
        if (securityProfile && !sandboxImage) throw new Error("--profile requires --sandbox-image container execution.");
        if (policyIndex >= 0 && (!sandboxPolicyPath || sandboxPolicyPath.startsWith("--"))) throw new Error("--policy requires a policy file path.");
        if (sandboxPolicyPath && !sandboxImage) throw new Error("--policy requires --sandbox-image container execution.");
        const result = await verifyStagedPatch(target, stageId, script, {
          installDependencies,
          ...(sandboxImage ? { sandboxImage } : {}),
          ...(requireRootless ? { requireRootless } : {}),
          ...(securityProfile ? { securityProfile: securityProfile as "balanced" | "hardened" | "rootless-required" } : {}),
          ...(sandboxPolicyPath ? { sandboxPolicyPath } : {}),
        });
        process.stdout.write(
          "# FORGE Staged Patch Verification\n\n" +
          "- **Stage:** `" + result.stageId + "`\n" +
          "- **Patch file:** `" + result.file + "`\n" +
          "- **Staged SHA-256:** `" + result.stagedSha256 + "`\n" +
          "- **Snapshot files:** `" + result.snapshotFileCount + "`\n" +
          "- **Snapshot bytes:** `" + result.snapshotBytes + "`\n" +
          (result.dependencyInstall ? "- **Dependencies:** **" + result.dependencyInstall.status.toUpperCase() + "** (`" + result.dependencyInstall.command + "`)\n" : "") +
          (sandboxImage ? "- **Execution:** **CONTAINER** (`" + sandboxImage + "`)\n" : "- **Execution:** **LOCAL HOST**\n") +
          "- **Verification:** **" + result.verification.status.toUpperCase() + "**\n" +
          "- **Duration:** `" + result.verification.durationMs + " ms`\n\n" +
          "## Output\n\n```\n" + (result.verification.output || "(No output captured.)") + "\n```\n\n" +
          "Temporary workspace was removed after verification. " + (sandboxImage ? "The container runtime and host kernel remain trusted." : "Project scripts ran on the local host; this is not an OS-level sandbox.") + "\n",
        );
        if (result.verification.status !== "passed") process.exitCode = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write("FORGE staged verification failed: " + message + "\n");
        process.exitCode = 1;
      }
      return;
    }
    case "verify-history": {
      const targetIndex = rest.indexOf("--path");
      const target = path.resolve(targetIndex >= 0 ? rest[targetIndex + 1] ?? "." : ".");
      try {
        const history = await listVerifications(target);
        if (!history.length) { process.stdout.write("No saved verification runs.\n"); return; }
        process.stdout.write(history.map(item => `${item.startedAt}  ${item.status.padEnd(12)} ${item.script.padEnd(16)} ${item.durationMs} ms  ${item.id}`).join("\n") + "\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Could not load verification history: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "review": {
      const json = rest.includes("--json");
      const all = rest.includes("--all");
      const pathIndex = rest.indexOf("--path");
      const baseIndex = rest.indexOf("--base");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : rest.find((arg,index) => !arg.startsWith("--") && rest[index-1] !== "--base" && rest[index-1] !== "--path") ?? ".");
      const base = baseIndex >= 0 ? rest[baseIndex + 1] ?? "HEAD" : "HEAD";
      try {
        const report = await reviewProject(target, { base, all });
        let ai: Awaited<ReturnType<typeof generateAIReview>> | undefined;
        if (rest.includes("--ai")) {
          const apiKey = process.env.FORGE_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
          if (!apiKey) throw new Error("Set FORGE_API_KEY (or OPENAI_API_KEY) before using --ai.");
          const provider = new OpenAICompatibleProvider({ apiKey, model: process.env.FORGE_MODEL ?? "gpt-4.1-mini", baseUrl: process.env.FORGE_BASE_URL ?? "https://api.openai.com/v1" });
          ai = await generateAIReview(report, provider);
        }
        const saved = await saveReview(target, report, ai);
        process.stdout.write(json ? JSON.stringify({ ...saved, reviewId: saved.id }, null, 2) + "\n" : formatCodeReview(report) + (ai ? "\n\n" + formatAIReview(ai) : "") + "\n\nSaved review: " + saved.id + "\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE code review failed: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "review-history": {
      const target = path.resolve(rest.find((arg,index)=>!arg.startsWith("--")&&rest[index-1]!=="--path") ?? ".");
      try { const records=await listReviews(target); process.stdout.write(records.length?records.map(r=>r.id+"  "+r.createdAt+"  "+r.report.findings.length+" static findings").join("\n")+"\n":"No saved reviews found.\n"); }
      catch(error){process.stderr.write("FORGE review history failed: "+(error instanceof Error?error.message:String(error))+"\n");process.exitCode=1;}
      return;
    }
    case "review-show": {
      const id=rest.find(arg=>!arg.startsWith("--")) ?? "";
      const pathIndex=rest.indexOf("--path");const target=path.resolve(pathIndex>=0?rest[pathIndex+1]??".":".");
      try { const record=await loadReview(target,id); process.stdout.write(formatReviewRecord(record)+"\n"); }
      catch(error){process.stderr.write("FORGE could not load review: "+(error instanceof Error?error.message:String(error))+"\n");process.exitCode=1;}
      return;
    }
    case "review-compare": {
      const ids=rest.filter((arg,index)=>!arg.startsWith("--")&&rest[index-1]!=="--path");
      const pathIndex=rest.indexOf("--path");const target=path.resolve(pathIndex>=0?rest[pathIndex+1]??".":".");
      try { if(ids.length<2)throw new Error("Usage: forge review-compare REVIEW_ID_A REVIEW_ID_B --path PROJECT"); const [a,b]=await Promise.all([loadReview(target,ids[0]!),loadReview(target,ids[1]!)]);const diff=compareReviews(a,b);process.stdout.write(["Review comparison", "Added ("+diff.added.length+")",...diff.added.map(x=>"+ "+x),"Resolved ("+diff.resolved.length+")",...diff.resolved.map(x=>"- "+x),"Persistent ("+diff.persistent.length+")",...diff.persistent.map(x=>"= "+x)].join("\n")+"\n"); }
      catch(error){process.stderr.write("FORGE review comparison failed: "+(error instanceof Error?error.message:String(error))+"\n");process.exitCode=1;}
      return;
    }
    case "regression": {
      const pathIndex=rest.indexOf("--path");
      const baseIndex=rest.indexOf("--base");
      const target=path.resolve(pathIndex>=0?rest[pathIndex+1]??".":rest.find((arg,index)=>!arg.startsWith("--")&&rest[index-1]!=="--base")??".");
      const base=baseIndex>=0?rest[baseIndex+1]??"HEAD":"HEAD";
      const json=rest.includes("--json");
      try {
        const report=await generateRegressionReport(target,base);
        process.stdout.write(json?JSON.stringify(report,null,2)+"\n":formatRegressionReport(report)+"\n");
        if(report.summary.regressions>0)process.exitCode=1;
      } catch(error) {
        process.stderr.write("FORGE regression analysis failed: "+(error instanceof Error?error.message:String(error))+"\n");
        process.exitCode=1;
      }
      return;
    }
    case "patch-review": {
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const stageId = rest.find((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--path") ?? "";
      try {
        if (!stageId) throw new Error("Usage: forge patch-review STAGE_ID --path PROJECT");
        const review = await reviewStagedPatch(target, stageId);
        process.stdout.write(["# FORGE Staged Patch Review", "- Stage: " + review.stageId, "- File: " + review.file, "- Source SHA-256: " + review.sourceSha256, "- Staged SHA-256: " + review.stagedSha256, "- Source unchanged: " + review.unchanged, "", review.diff].join("\n") + "\n");
      } catch (error) {
        process.stderr.write("FORGE staged patch review failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
        process.exitCode = 1;
      }
      return;
    }
    case "patch-stage": {
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const approvalId = rest.find((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--path") ?? "";
      try {
        if (!approvalId) throw new Error("Usage: forge patch-stage APPROVAL_ID --path PROJECT");
        const staged = await stageApprovedPatch(target, approvalId);
        process.stdout.write(["# FORGE Isolated Patch Stage", "- Stage: " + staged.id, "- Approval: " + staged.approvalId, "- File: " + staged.file, "- Staged copy: " + staged.stagedFile, "- SHA-256: " + staged.stagedSha256, "", "The original project file was not modified.", "No tests or commands were executed."].join("\n") + "\n");
      } catch (error) {
        process.stderr.write("FORGE patch staging failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
        process.exitCode = 1;
      }
      return;
    }
    case "patch-approve": {
      const pathIndex = rest.indexOf("--path");
      const reviewerIndex = rest.indexOf("--reviewer");
      const reasonIndex = rest.indexOf("--reason");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      const values = rest.filter((arg, index) => !arg.startsWith("--") && index !== pathIndex + 1 && index !== reviewerIndex + 1 && index !== reasonIndex + 1);
      const reviewId = values[0] ?? "";
      const suggestionNumber = Number(values[1]);
      const reviewer = reviewerIndex >= 0 ? rest[reviewerIndex + 1] ?? "" : "";
      const reason = reasonIndex >= 0 ? rest[reasonIndex + 1] : undefined;
      try {
        if (!reviewId || !Number.isInteger(suggestionNumber) || suggestionNumber < 1 || !reviewer.trim()) {
          throw new Error("Usage: forge patch-approve REVIEW_ID SUGGESTION_NUMBER --reviewer NAME [--reason TEXT] --path PROJECT");
        }
        const approval = await approveReviewPatch(target, reviewId, suggestionNumber, reviewer, reason);
        process.stdout.write(["# FORGE Patch Approval", "- Approval ID: " + approval.id, "- Review: " + approval.reviewId, "- Suggestion: " + approval.suggestionNumber, "- File: " + approval.file, "- Reviewer: " + approval.reviewer, "- Approved: " + approval.approvedAt, "- Expires: " + approval.expiresAt, "- Patch SHA-256: " + approval.patchSha256, "- Source SHA-256: " + approval.sourceSha256, "", "No source files were modified."].join("\\n") + "\\n");
      } catch (error) {
        process.stderr.write("FORGE patch approval failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "patch-approval-check": {
      const id = rest.find((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--path") ?? "";
      const pathIndex = rest.indexOf("--path");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : ".");
      try {
        if (!id) throw new Error("Usage: forge patch-approval-check APPROVAL_ID --path PROJECT");
        const result = await verifyPatchApproval(target, id);
        process.stdout.write((result.valid ? "VALID: " : "INVALID: ") + result.reason + "\\n");
        if (!result.valid) process.exitCode = 1;
      } catch (error) {
        process.stderr.write("FORGE patch approval check failed: " + (error instanceof Error ? error.message : String(error)) + "\\n");
        process.exitCode = 1;
      }
      return;
    }
    case "patch-check": {
      const id=rest.find((arg,index)=>!arg.startsWith("--")&&rest[index-1]!=="--path") ?? "";
      const pathIndex=rest.indexOf("--path");
      const target=path.resolve(pathIndex>=0?rest[pathIndex+1]??".":".");
      const numberArg=rest.find((arg,index)=>index>0&&!arg.startsWith("--")&&rest[index-1]!==id&&rest[index-1]!=="--path");
      try {
        if(!id||!numberArg)throw new Error("Usage: forge patch-check REVIEW_ID SUGGESTION_NUMBER --path PROJECT");
        const record=await loadReview(target,id);
        const result=await validateReviewPatch(target,record,Number(numberArg));
        process.stdout.write(formatPatchValidation(result)+"\n");
        if(result.status!=="applicable")process.exitCode=1;
      } catch(error) {
        process.stderr.write("FORGE patch validation failed: "+(error instanceof Error?error.message:String(error))+"\n");
        process.exitCode=1;
      }
      return;
    }
    case "git": {
      const json = rest.includes("--json");
      const pathIndex = rest.indexOf("--path");
      const baseIndex = rest.indexOf("--base");
      const target = path.resolve(pathIndex >= 0 ? rest[pathIndex + 1] ?? "." : rest.find(arg => !arg.startsWith("--")) ?? ".");
      const base = baseIndex >= 0 ? rest[baseIndex + 1] ?? "HEAD" : "HEAD";
      try {
        const report = await analyzeGitChanges(target, base);
        process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : formatGitIntelligence(report) + "\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE Git analysis failed: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "deep": {
      const json = rest.includes("--json");
      const target = path.resolve(rest.find(arg => !arg.startsWith("--")) ?? ".");
      try {
        const report = await analyzeCodebase(target);
        process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : formatCodebaseAnalysis(report) + "\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE deep analysis failed: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "remediate": {
      if (rest.includes("--help")) {
        process.stdout.write("Usage: forge remediate [path] [--audit-report FILE] [--outdated-report FILE] [--json]\n");
        return;
      }
      const option = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
      const target = path.resolve(rest.find((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--audit-report" && rest[index - 1] !== "--outdated-report") ?? ".");
      try {
        const auditReport = option("--audit-report"), outdatedReport = option("--outdated-report");
        const plan = await generateRemediationPlan(target, { ...(auditReport ? { auditReport } : {}), ...(outdatedReport ? { outdatedReport } : {}) });
        process.stdout.write(rest.includes("--json") ? JSON.stringify(plan, null, 2) + "\n" : formatRemediationPlan(plan) + "\n");
      } catch (error) {
        process.stderr.write("FORGE remediation planning failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
        process.exitCode = 1;
      }
      return;
    }
    case "health": {
      const json = rest.includes("--json");
      const target = path.resolve(rest.find(arg => !arg.startsWith("--")) ?? ".");
      try {
        const report = await generateProjectHealth(target);
        process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : formatProjectHealthMarkdown(report) + "\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE health report failed: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "quality": {
      if (rest.includes("--help")) {
        process.stdout.write("Usage: forge quality [path] [--json]\n");
        return;
      }
      const json = rest.includes("--json");
      const target = rest.find(arg => !arg.startsWith("--")) ?? ".";
      try {
        const report = await auditProject(path.resolve(target));
        process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatQualityAudit(report)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE quality audit failed: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "inspect":
    case "map": {
      if (rest.includes("--help")) {
        process.stdout.write(`Usage: forge ${command} [path] [--json]\n`);
        return;
      }
      const json = rest.includes("--json");
      const target = rest.find(arg => !arg.startsWith("--")) ?? ".";
      try {
        if (command === "inspect") {
          const report = await inspectProject(path.resolve(target));
          process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatProjectReport(report)}\n`);
        } else {
          const report = await mapArchitecture(path.resolve(target));
          process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatArchitectureMap(report)}\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`FORGE could not ${command} this project: ${message}\n`);
        process.exitCode = 1;
      }
      return;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\nRun "forge help" to see available commands.\n`);
      process.exitCode = 1;
  }
}
void main(process.argv.slice(2));
