import { describe, expect, it } from "vitest";
import { createReviewPlan } from "../src/core/review-planner.js";

describe("specialist review plan", () => {
  it("creates a dependency-aware workflow with all specialist perspectives", () => {
    const plan = createReviewPlan("Improve the MCP server reliability");
    const byId = new Map(plan.tasks.map(record => [record.task.id, record.task]));
    expect(plan.tasks).toHaveLength(10);
    expect(byId.get("understand")?.agent).toBe("architect");
    expect(byId.get("plan")?.dependsOn).toEqual(["understand"]);
    for (const id of ["review", "security", "performance", "debugging", "tests", "docs", "delivery"]) {
      expect(byId.get(id)?.dependsOn).toEqual(["plan"]);
    }
    expect(byId.get("release")?.dependsOn).toHaveLength(7);
  });

  it("rejects an empty goal", () => {
    expect(() => createReviewPlan("  ")).toThrow("Provide a goal");
  });
});
