import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";import path from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {reviewProject} from "../src/core/code-review.js";
const run=promisify(execFile);
describe("code review",()=>{let root:string|undefined;afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});});
it("reports heuristic findings with file and line evidence",async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),"forge-review-"));await mkdir(path.join(root,"src"));
 await writeFile(path.join(root,"src","sample.ts"),"export const safe = 1;");
 await run("git",["init",root]);await run("git",["-C",root,"config","user.email","forge@example.invalid"]);await run("git",["-C",root,"config","user.name","FORGE Tests"]);await run("git",["-C",root,"add","."]);await run("git",["-C",root,"commit","-m","baseline"]);
 await writeFile(path.join(root,"src","sample.ts"),"export const safe = 1;\neval(input);\nnode.innerHTML = value;\n");
 const report=await reviewProject(root);expect(report.findings.some(f=>f.ruleId==="FORGE-R001"&&f.line===2)).toBe(true);expect(report.summary.medium).toBeGreaterThan(0);
});
it("supports reviewing all source files without a Git diff",async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),"forge-review-all-"));await mkdir(path.join(root,"src"));await writeFile(path.join(root,"src","x.js"),"new Function('return 1');");
 const report=await reviewProject(root,{all:true});expect(report.scope).toBe("source-files");expect(report.findings[0]?.ruleId).toBe("FORGE-R001");
});});
