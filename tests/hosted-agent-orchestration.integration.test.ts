import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceRun, createRun } from "../src/core/orchestrator.js";
import { HostedAgentProvider } from "../src/core/hosted-agent-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hosted provider + multi-agent orchestration integration", () => {
  it("sends dependency handoffs through the hosted provider and holds approval-gated work", async () => {
    const requests: Array<{ url: string; headers: HeadersInit; body: Record<string, unknown> }> = [];
    let active = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      active += 1;
      peak = Math.max(peak, active);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({
        url: String(input),
        headers: init?.headers ?? {},
        body,
      });
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      const messages = body.messages as Array<{ content: string }>;
      const prompt = JSON.parse(messages[0]?.content ?? "{}") as {
        agent?: string;
        taskTitle?: string;
        completedDependencies?: Array<{ id: string; result: string }>;
      };
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "Proposal for " + (prompt.agent ?? "unknown") }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const provider = new HostedAgentProvider({
      provider: "anthropic",
      model: "test-model",
      apiKey: "test-key",
      baseUrl: "http://localhost:43129",
      timeoutMs: 5_000,
    });
    const run = createRun("Coordinate a small engineering review", [
      { id: "architecture", agent: "architect", title: "Map architecture", prompt: "Identify the main modules." },
      { id: "review", agent: "reviewer", title: "Review architecture", prompt: "Review the architecture proposal.", dependsOn: ["architecture"] },
      { id: "docs", agent: "documentation-writer", title: "Summarize modules", prompt: "Summarize the modules independently." },
      { id: "security", agent: "security-reviewer", title: "Review security", prompt: "Check the security boundaries.", requiresApproval: true },
    ]);

    const held = await advanceRun(run, provider, new Set(), { maxConcurrency: 2 });
    expect(held.status).toBe("awaiting_approval");
    expect(held.tasks.find(task => task.task.id === "architecture")?.status).toBe("completed");
    expect(held.tasks.find(task => task.task.id === "review")?.status).toBe("completed");
    expect(held.tasks.find(task => task.task.id === "security")?.status).toBe("awaiting_approval");
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.url === "http://localhost:43129/v1/messages")).toBe(true);
    expect(requests.every(request => (request.headers as Record<string, string>)["x-api-key"] === "test-key")).toBe(true);
    expect(peak).toBe(2); // Independent work overlaps; the dependent review waits for architecture.

    const reviewRequest = requests.find(request => {
      const messages = request.body.messages as Array<{ content: string }>;
      return JSON.parse(messages[0]?.content ?? "{}").agent === "reviewer";
    });
    expect(reviewRequest).toBeDefined();
    const reviewPrompt = JSON.parse((reviewRequest?.body.messages as Array<{ content: string }>)[0]!.content) as {
      completedDependencies: Array<{ id: string; fromAgent: string; result: string }>;
    };
    expect(reviewPrompt.completedDependencies).toEqual([
      expect.objectContaining({
        id: "architecture",
        fromAgent: "architect",
        result: "Proposal for architect",
      }),
    ]);

    const completed = await advanceRun(held, provider, new Set(["security"]), { maxConcurrency: 2 });
    expect(completed.status).toBe("completed");
    expect(completed.tasks.every(task => task.status === "completed")).toBe(true);
    expect(requests).toHaveLength(4);
    expect(requests.some(request => {
      const messages = request.body.messages as Array<{ content: string }>;
      return JSON.parse(messages[0]?.content ?? "{}").agent === "security-reviewer";
    })).toBe(true);
  });
});
