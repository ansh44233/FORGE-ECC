import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureAgentConfigVersion } from "../src/core/agent-config-versioning.js";
import { decideAgentConfigRelease, listAgentConfigReleases, prepareAgentConfigRelease } from "../src/core/agent-config-release.js";
import type { BenchmarkRegressionReport } from "../src/core/benchmark-regression.js";
import { fingerprintAgentConfig } from "../src/core/benchmark-matrix.js";

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-release-"));
  roots.push(root);
  await mkdir(path.join(root, ".forge", "agents"), { recursive: true });
  await writeFile(path.join(root, ".forge", "agents", "planner.md"), "# Planner\nPlan.\n");
  const baseline = await captureAgentConfigVersion(root);
  const approvedBaseline = { ...baseline, status: "approved" as const, approvedBy: "owner" };
  await writeFile(path.join(root, ".forge", "config-versions", baseline.id + ".json"), JSON.stringify(approvedBaseline));
  await writeFile(path.join(root, ".forge", "config-versions", "approved.json"), JSON.stringify({ version: 1, activeApprovedVersionId: baseline.id }));
  await writeFile(path.join(root, ".forge", "agents", "planner.md"), "# Planner\nPlan with evidence.\n");
  const candidate = await captureAgentConfigVersion(root);
  const regression: BenchmarkRegressionReport = {
    status: "release-ready", matrixId: "matrix-one", matrixName: "Matrix", suiteId: "engineering-basics",
    baselineAt: "2026-01-01T00:00:00.000Z", currentAt: "2026-01-02T00:00:00.000Z",
    candidates: [], candidateProvenance: [{ candidateId: "candidate-a", configVersionId: candidate.id, fingerprint: fingerprintAgentConfig(candidate.files) }], agents: [], summary: ["Comparable benchmark passed."]
  };
  return { root, baseline, candidate, regression };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("agent config release pipeline", () => {
  it("requires release-ready evidence and explicit approval before updating approved pointer", async () => {
    const { root, baseline, candidate, regression } = await setup();
    const pending = await prepareAgentConfigRelease(root, { candidateVersionId: candidate.id, baselineVersionId: baseline.id, regression });
    expect(pending.status).toBe("pending-approval");
    expect((await listAgentConfigReleases(root))).toHaveLength(1);
    const approved = await decideAgentConfigRelease(root, pending.id, "maintainer", "approve");
    expect(approved.status).toBe("approved");
    const pointer = JSON.parse(await readFile(path.join(root, ".forge", "config-versions", "approved.json"), "utf8"));
    expect(pointer.activeApprovedVersionId).toBe(candidate.id);
    expect(pointer.releaseId).toBe(pending.id);
  });
  it("blocks a release when benchmark provenance does not match the candidate snapshot", async () => {
    const { root, baseline, candidate, regression } = await setup();
    await expect(prepareAgentConfigRelease(root, { candidateVersionId: candidate.id, baselineVersionId: baseline.id, regression: { ...regression, candidateProvenance: [] } })).rejects.toThrow("does not match a configuration snapshot fingerprint");
  });
  it("blocks warning or insufficient-history reports", async () => {
    const { root, baseline, candidate, regression } = await setup();
    await expect(prepareAgentConfigRelease(root, { candidateVersionId: candidate.id, baselineVersionId: baseline.id, regression: { ...regression, status: "warning" } })).rejects.toThrow("Promotion blocked");
  });
  it("rejects rejected and already-decided releases", async () => {
    const { root, baseline, candidate, regression } = await setup();
    const pending = await prepareAgentConfigRelease(root, { candidateVersionId: candidate.id, baselineVersionId: baseline.id, regression });
    await decideAgentConfigRelease(root, pending.id, "reviewer", "reject");
    await expect(decideAgentConfigRelease(root, pending.id, "reviewer", "approve")).rejects.toThrow("Only pending releases");
  });
});
