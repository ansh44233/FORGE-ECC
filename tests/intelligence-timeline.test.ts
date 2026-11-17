import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureIntelligenceSnapshot, compareIntelligenceSnapshots, listIntelligenceSnapshots } from "../src/core/intelligence-timeline.js";
let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });
describe("engineering intelligence timeline", () => {
  it("captures local snapshots and compares risk metrics and hotspot membership", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-intel-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFile(path.join(root, "README.md"), "# Timeline fixture");
    await writeFile(path.join(root, "src", "shared.ts"), "export const shared = true;\n");
    const first = await captureIntelligenceSnapshot(root);
    expect(first.trend).toBe("baseline");
    const history = await listIntelligenceSnapshots(root);
    expect(history).toHaveLength(1);
    const current = { ...first.current, id: "intel-11111111-1111-4111-8111-111111111111", metrics: { ...first.current.metrics, score: first.current.metrics.score + 10, high: first.current.metrics.high + 1 }, topHotspots: [{ file: "src/new.ts", score: 90, level: "high" }] };
    const comparison = compareIntelligenceSnapshots(current, first.current);
    expect(comparison.trend).toBe("regressed");
    expect(comparison.delta?.score).toBe(10);
    expect(comparison.newHotspots).toContain("src/new.ts");
    expect(comparison.resolvedHotspots).toEqual(first.current.topHotspots.map(item => item.file));
  });
});
