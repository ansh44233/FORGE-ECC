import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatProjectReport, inspectProject } from "../src/core/project-inspector.js";

describe("inspectProject", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("detects TypeScript, npm metadata, scripts, and frameworks", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-test-"));
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export {};");
    await writeFile(path.join(root, "node_modules", "ignored", "fake.js"), "");
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
      dependencies: { react: "^19.0.0" },
      devDependencies: { typescript: "^5.0.0" }
    }));
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(path.join(root, "README.md"), "# Demo");

    const report = await inspectProject(root);
    expect(report.summary.filesScanned).toBe(4);
    expect(report.summary.languages).toContainEqual({ name: "TypeScript", files: 1 });
    expect(report.packageManagers).toContain("npm");
    expect(report.frameworks).toContain("React");
    expect(report.scripts.test).toBe("vitest run");
    expect(report.importantFiles).toContain("README.md");
  });


  it("does not traverse private configuration directories", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-private-scan-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".forge", "agents"), { recursive: true });
    await mkdir(path.join(root, ".ssh"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "export {};");
    await writeFile(path.join(root, ".forge", "agents", "private.ts"), "export {};");
    await writeFile(path.join(root, ".ssh", "helper.ts"), "export {};");
    const report = await inspectProject(root);
    expect(report.summary.filesScanned).toBe(1);
    expect(report.topLevel).toEqual(["src"]);
  });

  it("formats a readable report", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-test-"));
    await writeFile(path.join(root, "main.py"), "print('hello')");
    const report = await inspectProject(root);
    expect(formatProjectReport(report)).toContain("# FORGE Project Intelligence");
    expect(formatProjectReport(report)).toContain("Python");
  });
});
