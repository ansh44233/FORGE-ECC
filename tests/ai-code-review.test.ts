import {describe,it,expect,vi} from "vitest";
import {generateAIReview} from "../src/core/ai-code-review.js";
import type {AgentProvider} from "../src/core/orchestrator.js";
import type {CodeReviewReport} from "../src/core/code-review.js";
const base:CodeReviewReport={root:process.cwd(),generatedAt:new Date().toISOString(),scope:"source-files",base:"HEAD",filesReviewed:["package.json"],findings:[],summary:{high:0,medium:0,low:0},warnings:[]};
describe("AI code review",()=>{
 it("accepts only structured suggestions for supplied files",async()=>{
  const provider:AgentProvider={name:"test",complete:vi.fn(async()=>({provider:"test",model:"mock",content:JSON.stringify({suggestions:[{file:"package.json",line:1,severity:"low",title:"Check config",explanation:"Potential concern",recommendation:"Verify it",confidence:"medium",patch:"--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n- old\n+ new"},{file:"secret.ts",line:1,severity:"high",title:"Invented",explanation:"x",recommendation:"x",confidence:"high"},{file:"package.json",line:1,severity:"low",title:"Bad patch",explanation:"x",recommendation:"x",confidence:"low",patch:"--- a/other.ts\\n+++ b/other.ts\\n@@ -1 +1 @@"}]})}))};
  const result=await generateAIReview(base,provider);expect(result.suggestions).toHaveLength(2);expect(result.suggestions[0]?.file).toBe("package.json");expect(result.suggestions[0]?.patch).toContain("@@ -1 +1 @@");expect(result.suggestions[1]?.patch).toBeUndefined();
 });
 it("rejects malformed provider output",async()=>{
  const provider:AgentProvider={name:"bad",complete:vi.fn(async()=>({provider:"bad",content:"not json"}))};
  await expect(generateAIReview(base,provider)).rejects.toThrow("not valid JSON");
 });
});
