import {mkdtemp,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {compareReviews,listReviews,loadReview,saveReview} from "../src/core/review-history.js";
import type {CodeReviewReport} from "../src/core/code-review.js";
const report=(title:string):CodeReviewReport=>({root:"/tmp/demo",generatedAt:new Date().toISOString(),scope:"source-files",base:"HEAD",filesReviewed:["src/a.ts"],findings:[{ruleId:"FORGE-R1",severity:"low",file:"src/a.ts",line:2,title,evidence:"x",recommendation:"fix",confidence:"heuristic"}],summary:{high:0,medium:0,low:1},warnings:[]});
describe("review history",()=>{let root="";afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});});
it("saves, lists, and loads immutable review snapshots",async()=>{root=await mkdtemp(path.join(os.tmpdir(),"forge-history-"));const saved=await saveReview(root,report("Finding"));expect((await listReviews(root))).toHaveLength(1);expect((await loadReview(root,saved.id)).report.findings[0]?.title).toBe("Finding");});
it("compares findings across snapshots",()=>{const a={id:"review-00000000-0000-4000-8000-000000000000",createdAt:"1",report:report("Old")};const b={id:"review-00000000-0000-4000-8000-000000000001",createdAt:"2",report:report("New")};const diff=compareReviews(a,b);expect(diff.added).toHaveLength(1);expect(diff.resolved).toHaveLength(1);});
});
