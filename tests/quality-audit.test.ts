import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditProject, formatQualityAudit } from "../src/core/quality-audit.js";

describe("auditProject", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root,{recursive:true,force:true}); root=""; });
  it("reports missing engineering foundations with evidence", async () => {
    root=await mkdtemp(path.join(os.tmpdir(),"forge-quality-"));
    await mkdir(path.join(root,"src"));
    await writeFile(path.join(root,"src","main.ts"),"export const value = 1;");
    const report=await auditProject(root);
    expect(report.findings.map(item=>item.id)).toContain("docs.readme");
    expect(report.findings.map(item=>item.id)).toContain("tests.files");
    expect(report.metrics.sourceFiles).toBe(1);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(formatQualityAudit(report)).toContain("# FORGE Quality Report");
  });

  it("excludes private configuration directories from audit metrics", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-quality-private-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".forge", "agents"), { recursive: true });
    await mkdir(path.join(root, ".ssh"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "export {};");
    await writeFile(path.join(root, ".forge", "agents", "private.ts"), "export {};");
    await writeFile(path.join(root, ".ssh", "helper.ts"), "export {};");
    const report = await auditProject(root);
    expect(report.metrics.sourceFiles).toBe(1);
    expect(report.metrics.testFiles).toBe(0);
    expect(JSON.stringify(report)).not.toContain(".ssh");
    expect(JSON.stringify(report)).not.toContain(".forge/agents");
  });

  it("detects test, CI, strict TypeScript, and never reads env contents", async () => {
    root=await mkdtemp(path.join(os.tmpdir(),"forge-quality-"));
    await mkdir(path.join(root,"tests"));
    await mkdir(path.join(root,".github","workflows"),{recursive:true});
    await writeFile(path.join(root,"README.md"),"# Demo");
    await writeFile(path.join(root,"LICENSE"),"MIT");
    await writeFile(path.join(root,".gitignore"),".env");
    await writeFile(path.join(root,".env"),"TOKEN=not-to-be-read");
    await writeFile(path.join(root,"tests","main.test.ts"),"test('ok',()=>{});");
    await writeFile(path.join(root,".github","workflows","ci.yml"),"name: CI");
    await writeFile(path.join(root,"tsconfig.json"),JSON.stringify({compilerOptions:{strict:true}}));
    await writeFile(path.join(root,"package.json"),JSON.stringify({engines:{node:">=22"},scripts:{test:"vitest run"}}));
    const report=await auditProject(root);
    expect(report.metrics.testFiles).toBe(1);
    expect(report.metrics.workflowFiles).toBe(1);
    expect(report.findings.map(item=>item.id)).toContain("secrets.env");
    expect(JSON.stringify(report)).not.toContain("not-to-be-read");
    expect(report.findings.map(item=>item.id)).not.toContain("tests.files");
    expect(report.findings.map(item=>item.id)).not.toContain("ci.workflow");
  });
});
