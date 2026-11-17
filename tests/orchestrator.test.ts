import { describe, expect, it } from "vitest";
import {
  advanceRun,
  createRun,
  DemoAgentProvider,
  PlanValidationError,
  type AgentProvider,
} from "../src/core/orchestrator.js";

const provider = new DemoAgentProvider();

describe("FORGE orchestration engine", () => {
  it("rejects empty and malformed provider responses", async () => {
    const invalidResponses = [
      { provider: "test", content: "   " },
      { provider: "", content: "proposal" },
      { provider: "test", content: 42 },
      { provider: "test", content: "proposal", model: 42 },
    ];
    for (const response of invalidResponses) {
      const invalidProvider: AgentProvider = {
        name: "invalid-response-test",
        async complete() { return response as never; },
      };
      const run = createRun("Validate provider output", [
        { id: "one", agent: "planner", title: "One", prompt: "One" },
      ]);
      const result = await advanceRun(run, invalidProvider);
      expect(result.status).toBe("failed");
      expect(result.tasks[0]?.error).toContain("invalid or empty agent proposal");
    }
  });

  it("rejects invalid concurrency limits instead of stalling", async () => {
    const run = createRun("Invalid concurrency", [
      { id: "one", agent: "planner", title: "One", prompt: "One" },
    ]);
    for (const maxConcurrency of [0, -1, 1.5, 17, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(advanceRun(run, provider, new Set(), { maxConcurrency }))
        .rejects.toThrow("Maximum agent concurrency must be an integer between 1 and 16.");
    }
  });


  it("validates duplicate, missing, and cyclic dependencies", () => {
    expect(() => createRun("goal", [
      { id: "a", agent: "planner", title: "A", prompt: "Do A" },
      { id: "a", agent: "planner", title: "Duplicate", prompt: "Do it" },
    ])).toThrow(PlanValidationError);

    expect(() => createRun("goal", [
      { id: "a", agent: "planner", title: "A", prompt: "Do A", dependsOn: ["missing"] },
    ])).toThrow(/unknown task/);

    expect(() => createRun("goal", [
      { id: "a", agent: "planner", title: "A", prompt: "Do A", dependsOn: ["b"] },
      { id: "b", agent: "planner", title: "B", prompt: "Do B", dependsOn: ["a"] },
    ])).toThrow(/cycle/);
  });

  it("publishes running and completed progress snapshots", async () => {
    const snapshots: Array<{ status: string; taskStatus: string }> = [];
    const run = createRun("Monitor progress", [
      { id: "inspect", agent: "architect", title: "Inspect", prompt: "Inspect" },
    ]);
    const result = await advanceRun(run, provider, new Set(), {
      onUpdate: snapshot => snapshots.push({
        status: snapshot.status,
        taskStatus: snapshot.tasks[0]?.status ?? "missing",
      }),
    });
    expect(snapshots.some(item => item.status === "running" && item.taskStatus === "running")).toBe(true);
    expect(snapshots.at(-1)).toEqual({ status: "completed", taskStatus: "completed" });
    expect(result.status).toBe("completed");
  });

  it("honors cooperative cancellation before starting another batch", async () => {
    let calls = 0;
    const cancelProvider: AgentProvider = {
      name: "cancel-test",
      async complete() { calls += 1; return { provider: "cancel-test", content: "done" }; },
    };
    const run = createRun("Cancel between batches", [
      { id: "first", agent: "planner", title: "First", prompt: "First" },
      { id: "second", agent: "reviewer", title: "Second", prompt: "Second" },
    ]);
    const result = await advanceRun(run, cancelProvider, new Set(), {
      maxConcurrency: 1,
      shouldCancel: () => calls > 0,
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("cancelled");
    expect(result.tasks[0]?.status).toBe("completed");
    expect(result.tasks[1]?.status).toBe("pending");
  });

  it("runs dependency-ordered tasks and passes completed context", async () => {
    const run = createRun("Improve reliability", [
      { id: "inspect", agent: "architect", title: "Inspect", prompt: "Inspect structure" },
      { id: "plan", agent: "planner", title: "Plan", prompt: "Create plan", dependsOn: ["inspect"] },
    ]);
    const result = await advanceRun(run, provider);
    expect(result.status).toBe("completed");
    expect(result.tasks[1]?.result?.content).toContain("inspect");
  });

  it("runs independent tasks concurrently but respects the configured limit", async () => {
    let active = 0;
    let peak = 0;
    const concurrentProvider: AgentProvider = {
      name: "concurrency-test",
      async complete() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 15));
        active -= 1;
        return { provider: "concurrency-test", content: "done" };
      },
    };
    const run = createRun("Parallel review", [
      { id: "a", agent: "reviewer", title: "A", prompt: "A" },
      { id: "b", agent: "reviewer", title: "B", prompt: "B" },
      { id: "c", agent: "reviewer", title: "C", prompt: "C" },
      { id: "d", agent: "reviewer", title: "D", prompt: "D" },
      { id: "e", agent: "reviewer", title: "E", prompt: "E" },
    ]);
    const result = await advanceRun(run, concurrentProvider, new Set(), { maxConcurrency: 2 });
    expect(result.status).toBe("completed");
    expect(peak).toBe(2);
    expect(result.tasks.every(task => task.status === "completed")).toBe(true);
  });

  it("stops scheduling pending tasks when a provider reports budget exhaustion", async () => {
    const started: string[] = [];
    const budgetProvider: AgentProvider = {
      name: "budget-test",
      async complete(request) {
        started.push(request.task.id);
        if (request.task.id === "first") throw new Error("FORGE budget exceeded: run token limit reached.");
        return { provider: "budget-test", content: "done" };
      },
    };
    const run = createRun("Budget stop", [
      { id: "first", agent: "planner", title: "First", prompt: "First" },
      { id: "second", agent: "reviewer", title: "Second", prompt: "Second" },
      { id: "third", agent: "tester", title: "Third", prompt: "Third" },
    ]);
    const result = await advanceRun(run, budgetProvider, new Set(), { maxConcurrency: 1 });
    expect(started).toEqual(["first"]);
    expect(result.status).toBe("failed");
    expect(result.tasks[1]?.status).toBe("blocked");
    expect(result.events.some(event => event.type === "budget_exceeded")).toBe(true);
  });

  it("does not start dependent tasks before their prerequisites finish", async () => {
    const started: string[] = [];
    const trackingProvider: AgentProvider = {
      name: "dependency-test",
      async complete(request) {
        started.push(request.task.id);
        return { provider: "dependency-test", content: request.task.id };
      },
    };
    const run = createRun("Dependency ordering", [
      { id: "root", agent: "architect", title: "Root", prompt: "Root" },
      { id: "child", agent: "planner", title: "Child", prompt: "Child", dependsOn: ["root"] },
      { id: "independent", agent: "reviewer", title: "Independent", prompt: "Independent" },
    ]);
    const result = await advanceRun(run, trackingProvider, new Set(), { maxConcurrency: 3 });
    expect(result.status).toBe("completed");
    expect(started.indexOf("child")).toBeGreaterThan(started.indexOf("root"));
  });

  it("passes bounded project context to agent providers", async () => {
    let receivedContext = "";
    const contextProvider: AgentProvider = {
      name: "context-test",
      async complete(request) {
        receivedContext = request.projectContext ?? "";
        return { provider: "context-test", content: "done" };
      },
    };
    const run = createRun("Use project memory", [
      { id: "one", agent: "planner", title: "One", prompt: "Use context" },
    ]);
    await advanceRun(run, contextProvider, new Set(), { projectContext: "Relevant local project decision." });
    expect(receivedContext).toContain("Relevant local project decision.");
  });

  it("builds task-specific context independently for each agent", async () => {
    const received = new Map<string, string>();
    const contextProvider: AgentProvider = {
      name: "task-context-test",
      async complete(request) {
        received.set(request.task.agent, request.projectContext ?? "");
        return { provider: "task-context-test", content: "done" };
      },
    };
    const run = createRun("Agent-specific guidance", [
      { id: "secure", agent: "security-reviewer", title: "Review permissions", prompt: "Check auth" },
      { id: "docs", agent: "documentation-writer", title: "Update guide", prompt: "Write docs" },
    ]);
    await advanceRun(run, contextProvider, new Set(), {
      projectContext: "Shared project memory",
      projectContextForTask: async task => "Skill for " + task.agent,
    });
    expect(received.get("security-reviewer")).toContain("Skill for security-reviewer");
    expect(received.get("documentation-writer")).toContain("Skill for documentation-writer");
    expect(received.get("security-reviewer")).toContain("Shared project memory");
  });

  it("passes source-agent provenance with completed dependency handoffs", async () => {
    let received: { id: string; fromAgent?: string; taskTitle?: string; result: string }[] = [];
    const handoffProvider: AgentProvider = {
      name: "handoff-test",
      async complete(request) {
        received = [...request.completedDependencies];
        return { provider: "handoff-test", content: "proposal" };
      },
    };
    const run = createRun("Agent handoff", [
      { id: "architect", agent: "architect", title: "Map architecture", prompt: "Map it" },
      { id: "reviewer", agent: "code-reviewer", title: "Review architecture", prompt: "Review findings", dependsOn: ["architect"] },
    ]);
    await advanceRun(run, handoffProvider);
    expect(received[0]).toMatchObject({ id: "architect", fromAgent: "architect", taskTitle: "Map architecture" });
    expect(received[0]?.result).toBe("proposal");
  });
  it("holds approval-gated work until explicit approval", async () => {
    const run = createRun("Review a change", [
      { id: "review", agent: "reviewer", title: "Review", prompt: "Review proposal", requiresApproval: true },
    ]);
    const held = await advanceRun(run, provider);
    expect(held.status).toBe("awaiting_approval");
    expect(held.tasks[0]?.status).toBe("awaiting_approval");

    const approved = await advanceRun(held, provider, new Set(["review"]));
    expect(approved.status).toBe("completed");
  });

  it("records provider failures and blocks dependent tasks", async () => {
    const failing: AgentProvider = {
      name: "failing-test-provider",
      async complete() { throw new Error("provider unavailable"); },
    };
    const run = createRun("Test failure handling", [
      { id: "first", agent: "planner", title: "First", prompt: "Fail" },
      { id: "second", agent: "tester", title: "Second", prompt: "Depends", dependsOn: ["first"] },
    ]);
    const result = await advanceRun(run, failing);
    expect(result.status).toBe("failed");
    expect(result.tasks[0]?.status).toBe("failed");
    expect(result.tasks[1]?.status).toBe("blocked");
  });

  it("persists each task as soon as its parallel provider call settles", async () => {
    const settled: Array<{ taskId: string; completed: string[] }> = [];
    const run = createRun("Persist individual settlements", [
      { id: "first", agent: "planner", title: "First", prompt: "First" },
      { id: "second", agent: "reviewer", title: "Second", prompt: "Second" },
    ]);
    const result = await advanceRun(run, provider, new Set(), {
      maxConcurrency: 2,
      onTaskSettled: snapshot => settled.push({
        taskId: snapshot.events.filter(event => event.type === "completed").at(-1)?.taskId ?? "",
        completed: snapshot.tasks.filter(task => task.status === "completed").map(task => task.task.id),
      }),
    });
    expect(result.status).toBe("completed");
    expect(settled).toHaveLength(2);
    expect(settled.every(item => item.completed.includes(item.taskId))).toBe(true);
    expect(new Set(settled.map(item => item.taskId))).toEqual(new Set(["first", "second"]));
  });
});
