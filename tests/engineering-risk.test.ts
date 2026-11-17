import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeEngineeringRisk } from "../src/core/engineering-risk.js";
let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });
describe("engineering risk intelligence", () => {
  it("ranks shared modules and exposes transparent structural signals", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-risk-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFile(path.join(root, "README.md"), "# Example");
    await writeFile(path.join(root, "src", "shared.ts"), "export const shared = true;\n");
    await writeFile(path.join(root, "src", "a.ts"), "import { shared } from './shared';\nexport const a = shared;\n");
    await writeFile(path.join(root, "src", "b.ts"), "import { shared } from './shared';\nexport const b = shared;\n");
    await writeFile(path.join(root, "src", "c.ts"), "import { shared } from './shared';\nexport const c = shared;\n");
    await writeFile(path.join(root, "tests", "shared.test.ts"), "import { shared } from '../src/shared';\n");
    const report = await analyzeEngineeringRisk(root);
    expect(report.summary.scannedFiles).toBe(5);
    expect(report.hotspots[0]?.file).toBe("src/shared.ts");
    expect(report.hotspots[0]?.fanIn).toBe(4); // Three source consumers plus the test import.
    expect(report.hotspots.find(item => item.file === "src/shared.ts")?.hasMatchingTest).toBe(true);
    expect(report.methodology).toContain("fan-in 30%");
    expect(report.warnings.some(item => item.includes("do not measure defect probability"))).toBe(true);
  });
});
