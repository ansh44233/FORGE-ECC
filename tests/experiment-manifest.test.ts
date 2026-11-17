import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureExperimentManifest, compareExperimentManifests, loadExperimentManifest, saveExperimentManifest } from "../src/core/experiment-manifest.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("experiment manifests", () => {
  it("captures hashed inputs, saves, and reloads a manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-experiment-"));
    roots.push(root);
    await mkdir(path.join(root, ".git"), { recursive: true });
    const matrix = path.join(root, "matrix.json");
    await writeFile(matrix, JSON.stringify({ id: "matrix-a", candidates: [] }));
    const manifest = await captureExperimentManifest({ projectPath: root, matrixFile: matrix, matrixId: "matrix-a", suiteId: "suite-a", suite: { cases: ["one"] }, provider: "matrix", model: "candidate-specific" });
    expect(manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.inputs.matrixSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.environment).toBeDefined();
    expect(JSON.stringify(manifest)).not.toMatch(/OPENAI_API_KEY|FORGE_API_KEY|secret-value/);
    const saved = await saveExperimentManifest(root, manifest);
    expect((await loadExperimentManifest(root, manifest.id)).fingerprint).toBe(manifest.fingerprint);
    expect(JSON.parse(await readFile(saved, "utf8")).id).toBe(manifest.id);
  });
  it("reports differences in safe environment metadata", () => {
    const base = {
      version: 1 as const, id: "exp-aaaaaaaaaaaa", createdAt: "2026-01-01T00:00:00.000Z", fingerprint: "a".repeat(64),
      source: { commit: "abc", dirty: false }, runtime: { node: "v22", platform: "linux", architecture: "x64" },
      environment: { variables: [{ name: "NODE_ENV", value: "test" }], lockfiles: [] },
      inputs: { matrixId: "m", matrixSha256: "a".repeat(64), suiteId: "s", suiteSha256: "b".repeat(64), packageLockSha256: null },
      provider: { provider: "openai", model: "model-a", baseUrlHost: "api.openai.com" },
      configuration: { agentConfigFingerprints: [] }
    };
    const changed = compareExperimentManifests(base, { ...base, id: "exp-bbbbbbbbbbbb", environment: { variables: [{ name: "NODE_ENV", value: "production" }], lockfiles: [] } });
    expect(changed.compatible).toBe(false);
    expect(changed.differences).toContain("Allowlisted runtime environment variables or dependency lockfiles differ.");
  });
  it("flags mismatched source, suite, provider and pinned config", async () => {
    const base = {
      version: 1 as const, id: "exp-aaaaaaaaaaaa", createdAt: "2026-01-01T00:00:00.000Z", fingerprint: "a".repeat(64),
      source: { commit: "abc", dirty: false }, runtime: { node: "v22", platform: "linux", architecture: "x64" },
      environment: { variables: [], lockfiles: [] },
      inputs: { matrixId: "m", matrixSha256: "a".repeat(64), suiteId: "s", suiteSha256: "b".repeat(64), packageLockSha256: "c".repeat(64) },
      provider: { provider: "openai", model: "model-a", baseUrlHost: "api.openai.com" },
      configuration: { agentConfigFingerprints: [{ candidateId: "a", configVersionId: "cfg-aaaaaaaaaaaa", fingerprint: "d".repeat(64) }] }
    };
    const compatible = compareExperimentManifests(base, { ...base, id: "exp-bbbbbbbbbbbb" });
    expect(compatible.compatible).toBe(true);
    const changed = compareExperimentManifests(base, { ...base, id: "exp-cccccccccccc", source: { commit: "def", dirty: true }, inputs: { ...base.inputs, suiteSha256: "e".repeat(64) }, provider: { ...base.provider, model: "model-b" }, configuration: { agentConfigFingerprints: [] } });
    expect(changed.compatible).toBe(false);
    expect(changed.differences).toHaveLength(5);
  });
  it("rejects invalid manifest IDs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-experiment-invalid-"));
    roots.push(root);
    await expect(loadExperimentManifest(root, "../escape")).rejects.toThrow("Invalid experiment manifest ID");
  });
});
