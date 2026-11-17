import {afterEach,describe,expect,it} from "vitest";
import {mkdtemp,mkdir,rm,symlink,writeFile} from "node:fs/promises";
import os from "node:os";import path from "node:path";
import {searchWorkspace} from "../src/core/code-search.js";
let root="";afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});root=""});
describe("workspace code search",()=>{
it("finds declaration and reference locations",async()=>{root=await mkdtemp(path.join(os.tmpdir(),"forge-search-"));await mkdir(path.join(root,"src"));await writeFile(path.join(root,"src","main.ts"),"export function calculateTotal(value: number) { return value + 1; }\nconst result = calculateTotal(2);\n");const r=await searchWorkspace(root,"calculateTotal");expect(r.filesScanned).toBe(1);expect(r.total).toBe(2);expect(r.results.map(x=>x.kind)).toContain("declaration");expect(r.results.map(x=>x.kind)).toContain("reference")});
it("excludes hidden, generated, sensitive and linked files",async()=>{root=await mkdtemp(path.join(os.tmpdir(),"forge-search-"));await mkdir(path.join(root,"node_modules"));await writeFile(path.join(root,".env"),"searchNeedle");await writeFile(path.join(root,"secret.ts"),"searchNeedle");await writeFile(path.join(root,"node_modules","dep.ts"),"searchNeedle");await writeFile(path.join(root,"visible.ts"),"export const visible = true;");await symlink(path.join(root,"visible.ts"),path.join(root,"linked.ts"));const r=await searchWorkspace(root,"searchNeedle");expect(r.total).toBe(0);expect(r.filesScanned).toBe(1)});
it("validates query length and caps results",async()=>{root=await mkdtemp(path.join(os.tmpdir(),"forge-search-"));await writeFile(path.join(root,"many.ts"),Array.from({length:12},(_,i)=>"const target"+i+" = targetValue;").join("\n"));await expect(searchWorkspace(root,"x")).rejects.toThrow("at least 2");const r=await searchWorkspace(root,"target",2);expect(r.results).toHaveLength(2);expect(r.truncated).toBe(true)});

it("does not descend into nested sensitive directories",async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"forge-search-"));
  await mkdir(path.join(root,"src","credentials"),{recursive:true});
  await writeFile(path.join(root,"src","credentials","notes.ts"),"export const hiddenNeedle = true;");
  await writeFile(path.join(root,"src","visible.ts"),"export const visible = true;");
  const report=await searchWorkspace(root,"hiddenNeedle");
  expect(report.total).toBe(0);
  expect(report.filesScanned).toBe(1);
});

});
