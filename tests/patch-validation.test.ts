import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {validateReviewPatch} from "../src/core/patch-validation.js";
import type {ReviewRecord} from "../src/core/review-history.js";
const record=(patch:string):ReviewRecord=>({id:"review-00000000-0000-4000-8000-000000000000",createdAt:new Date().toISOString(),report:{root:"",generatedAt:"",scope:"source-files",base:"HEAD",filesReviewed:["src/a.ts"],findings:[],summary:{high:0,medium:0,low:0},warnings:[]},ai:{provider:"mock",suggestions:[{file:"src/a.ts",line:2,severity:"low",title:"Change value",explanation:"x",recommendation:"x",confidence:"medium",patch}],warnings:[]}});
describe("patch validation",()=>{let root="";afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});});
it("accepts a single-file patch whose context matches without editing the file",async()=>{root=await mkdtemp(path.join(os.tmpdir(),"forge-patch-"));await mkdir(path.join(root,"src"));const file=path.join(root,"src/a.ts");await writeFile(file,"const a = 1;\nconst b = 2;\n");const patch="--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;";const result=await validateReviewPatch(root,record(patch),1);expect(result.status).toBe("applicable");expect(await (await import("node:fs/promises")).readFile(file,"utf8")).toContain("const b = 2;");});
it("marks stale context instead of applying a patch",async()=>{root=await mkdtemp(path.join(os.tmpdir(),"forge-patch-"));await mkdir(path.join(root,"src"));await writeFile(path.join(root,"src/a.ts"),"const a = 9;\nconst b = 2;\n");const patch="--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;";expect((await validateReviewPatch(root,record(patch),1)).status).toBe("stale");});
it("rejects a patch that targets a different file",async()=>{root=await mkdtemp(path.join(os.tmpdir(),"forge-patch-"));expect((await validateReviewPatch(root,record("--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-old\n+new"),1)).status).toBe("invalid");});
it("rejects a symlink target even when its destination is inside the project",async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),"forge-patch-"));await mkdir(path.join(root,"src"));const outside=path.join(root,"outside.ts");await writeFile(outside,"const a = 1;");
 const {symlink}=await import("node:fs/promises");await symlink(outside,path.join(root,"src/a.ts"));
 const patch="--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2";
 expect((await validateReviewPatch(root,record(patch),1)).status).toBe("invalid");
});
it("rejects a patch whose target traverses a symlinked parent directory",async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),"forge-patch-"));const outside=path.join(root,"outside");await mkdir(outside);await writeFile(path.join(outside,"a.ts"),"const a = 1;");
 const {symlink}=await import("node:fs/promises");await symlink(outside,path.join(root,"src"),"dir");
 const patch="--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2";
 expect((await validateReviewPatch(root,record(patch),1)).status).toBe("invalid");
});
});
