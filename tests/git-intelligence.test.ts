import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach,describe,expect,it } from "vitest";
import { analyzeGitChanges } from "../src/core/git-intelligence.js";
const run=promisify(execFile);
describe("Git intelligence",()=>{
 let root:string|undefined;
 afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});});
 it("reports modified and untracked files with test suggestions",async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"forge-git-"));
  await mkdir(path.join(root,"src"),{recursive:true});
  await writeFile(path.join(root,"src","core.ts"),"export const value = 1;\n");
  await run("git",["init",root]); await run("git",["-C",root,"config","user.email","forge@example.invalid"]);
  await run("git",["-C",root,"config","user.name","FORGE Tests"]);
  await run("git",["-C",root,"add","."]); await run("git",["-C",root,"commit","-m","initial"]);
  await writeFile(path.join(root,"src","core.ts"),"export const value = 2;\n");
  await writeFile(path.join(root,"src","new.ts"),"export const next = true;\n");
  const report=await analyzeGitChanges(root);
  expect(report.changes.map(c=>c.file)).toContain("src/core.ts");
  expect(report.changes.map(c=>c.file)).toContain("src/new.ts");
  expect(report.suggestedTests.length).toBeGreaterThan(0);
 });
 it("rejects option-like and invalid base revisions before invoking git diff",async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"forge-git-base-"));
  await writeFile(path.join(root,"README.md"),"sample\\n");
  await run("git",["init",root]); await run("git",["-C",root,"config","user.email","forge@example.invalid"]);
  await run("git",["-C",root,"config","user.name","FORGE Tests"]);
  await run("git",["-C",root,"add","."]); await run("git",["-C",root,"commit","-m","initial"]);
  const marker=path.join(root,"should-not-be-created.txt");
  await expect(analyzeGitChanges(root,"--output="+marker)).rejects.toThrow(/valid commit revision/);
  await expect(access(marker)).rejects.toThrow();
  await expect(analyzeGitChanges(root,"not-a-real-revision")).rejects.toThrow(/valid commit revision/);
 });

 it("does not execute repository-configured external diff drivers",async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"forge-git-extdiff-"));
  await writeFile(path.join(root,"sample.txt"),"before\\n");
  await writeFile(path.join(root,".gitattributes"),"*.txt diff=evil\\n");
  await run("git",["init",root]); await run("git",["-C",root,"config","user.email","forge@example.invalid"]);
  await run("git",["-C",root,"config","user.name","FORGE Tests"]);
  const marker=path.join(root,"external-diff-ran.txt");
  await run("git",["-C",root,"config","diff.evil.command", "touch "+marker]);
  await run("git",["-C",root,"add","."]); await run("git",["-C",root,"commit","-m","initial"]);
  await writeFile(path.join(root,"sample.txt"),"after\\n");
  const report=await analyzeGitChanges(root);
  expect(report.changes.some(change=>change.file==="sample.txt")).toBe(true);
  await expect(access(marker)).rejects.toThrow();
 });

 it("flags deleted files as high risk",async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"forge-git-delete-"));
  await writeFile(path.join(root,"package.json"),'{"name":"sample"}');
  await run("git",["init",root]); await run("git",["-C",root,"config","user.email","forge@example.invalid"]);
  await run("git",["-C",root,"config","user.name","FORGE Tests"]);
  await run("git",["-C",root,"add","."]); await run("git",["-C",root,"commit","-m","initial"]);
  await rm(path.join(root,"package.json"));
  const report=await analyzeGitChanges(root);
  expect(report.risk.level).toBe("high");
  expect(report.risk.reasons.some(r=>r.includes("deleted"))).toBe(true);
 });
});
