import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeCodebase } from "../src/core/code-intelligence.js";

describe("AST code intelligence",()=>{
 let root:string|undefined;
 afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});});
 it("finds exported declarations and reverse import impact",async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"forge-ast-"));
  await mkdir(path.join(root,"src"),{recursive:true});
  await writeFile(path.join(root,"src","core.ts"),"export function calculate() { return 1; }\nexport interface Config { enabled: boolean }\n");
  await writeFile(path.join(root,"src","app.ts"),"import { calculate } from './core';\nexport class App { run() { return calculate(); } }\n");
  const report=await analyzeCodebase(root);
  expect(report.symbols.some(s=>s.name==="calculate"&&s.exported)).toBe(true);
  expect(report.symbols.some(s=>s.name==="Config"&&s.kind==="interface")).toBe(true);
  expect(report.impact.find(i=>i.file==="src/core.ts")?.affected).toContain("src/app.ts");
 });
 it("detects a circular import group",async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"forge-cycle-"));
  await mkdir(path.join(root,"src"),{recursive:true});
  await writeFile(path.join(root,"src","a.ts"),"import './b';\nexport const a = 1;\n");
  await writeFile(path.join(root,"src","b.ts"),"import './a';\nexport const b = 2;\n");
  const report=await analyzeCodebase(root);
  expect(report.circularDependencies.length).toBeGreaterThan(0);
 });
});
