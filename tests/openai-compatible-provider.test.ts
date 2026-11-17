import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/core/openai-compatible-provider.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validatePermissionPolicy } from "../src/core/permission-policy.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible provider", () => {
  it("sends a task and parses the assistant proposal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "A reviewed implementation proposal." } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-secret",
      model: "test-model",
    });
    const result = await provider.complete({
      task: { id: "review", agent: "reviewer", title: "Review", prompt: "Review this change" },
      completedDependencies: [],
    });
    expect(result.content).toContain("implementation proposal");
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Record<string, string>).authorization).toBe("Bearer test-secret");
  });


  it("rejects provider redirects rather than following them with a credentialed request", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("redirect mode is error"));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ apiKey: "test-secret", model: "test-model" });
    await expect(provider.complete({
      task: { id: "redirect", agent: "planner", title: "Redirect", prompt: "Test redirect" },
      completedDependencies: [],
    })).rejects.toThrow("redirect mode is error");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).redirect).toBe("error");
  });

  it("rejects non-HTTPS remote endpoints", () => {
    expect(() => new OpenAICompatibleProvider({
      apiKey: "key",
      model: "model",
      baseUrl: "http://example.com/v1",
    })).toThrow(/HTTPS/);
  });

  it("allows IPv6 loopback HTTP endpoints for local compatible providers", () => {
    expect(() => new OpenAICompatibleProvider({ apiKey: "key", model: "model", baseUrl: "http://[::1]:1234/v1" })).not.toThrow();
  });

  it("does not expose provider response bodies in errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret-bearing response", { status: 500 })));
    const provider = new OpenAICompatibleProvider({ apiKey: "test-secret", model: "test-model" });
    await expect(provider.complete({
      task: { id: "x", agent: "planner", title: "x", prompt: "x" },
      completedDependencies: [],
    })).rejects.toThrow("HTTP 500");
  });
  it("executes an explicitly allowed read-only tool call and returns its result to the model", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "forge-agent-tools-"));
    try {
      await mkdir(path.join(workspace, "src"));
      await writeFile(path.join(workspace, "src", "hello.ts"), "export const greeting = 'hello from workspace';");
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call_read_1", type: "function", function: { name: "read-file", arguments: JSON.stringify({ relativePath: "src/hello.ts" }) } }] } }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "The file exports a greeting constant." } }] }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const policy = validatePermissionPolicy({ version: 1, mode: "restricted", allowedTools: ["read-file"] });
      const provider = new OpenAICompatibleProvider({ apiKey: "test-secret", model: "test-model", workspacePath: workspace, permissionPolicy: policy });
      const result = await provider.complete({ task: { id: "inspect", agent: "reviewer", title: "Inspect file", prompt: "Read src/hello.ts" }, completedDependencies: [] });
      expect(result.content).toContain("greeting constant");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
      expect(JSON.stringify(body.messages)).toContain("hello from workspace");
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it("does not advertise tools under the default proposal-only policy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "Proposal only." } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ apiKey: "test-secret", model: "test-model" });
    await provider.complete({ task: { id: "plan", agent: "planner", title: "Plan", prompt: "Plan" }, completedDependencies: [] });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.tools).toBeUndefined();
  });

  it("rejects an oversized tool-call batch before executing any tool", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "forge-agent-tool-budget-"));
    try {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [
          { id: "call_one", type: "function", function: { name: "read-file", arguments: JSON.stringify({ relativePath: "src/one.ts" }) } },
          { id: "call_two", type: "function", function: { name: "read-file", arguments: JSON.stringify({ relativePath: "src/two.ts" }) } },
        ] } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);
      const policy = validatePermissionPolicy({ version: 1, mode: "restricted", allowedTools: ["read-file"] });
      const provider = new OpenAICompatibleProvider({
        apiKey: "test-secret", model: "test-model", workspacePath: workspace,
        permissionPolicy: policy, maxToolCalls: 1,
      });
      await expect(provider.complete({
        task: { id: "budget", agent: "reviewer", title: "Budget", prompt: "Read two files" },
        completedDependencies: [],
      })).rejects.toThrow("maximum number of tool calls");
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("validates the configured tool-call budget before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({ apiKey: "test-secret", model: "test-model", maxToolCalls: 11 });
    await expect(provider.complete({
      task: { id: "invalid-budget", agent: "reviewer", title: "Budget", prompt: "Review" },
      completedDependencies: [],
    })).rejects.toThrow("maxToolCalls must be an integer from 0 to 10");
    expect(fetchMock).not.toHaveBeenCalled();
  });


  it("rejects malformed tool-call identifiers and names without a second provider request", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "forge-agent-malformed-call-"));
    try {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [
          { id: "bad call id", type: "function", function: { name: "read-file", arguments: JSON.stringify({ relativePath: "src/hello.ts" }) } },
        ] } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);
      const policy = validatePermissionPolicy({ version: 1, mode: "restricted", allowedTools: ["read-file"] });
      const provider = new OpenAICompatibleProvider({
        apiKey: "test-secret", model: "test-model", workspacePath: workspace, permissionPolicy: policy,
      });
      await expect(provider.complete({
        task: { id: "malformed", agent: "reviewer", title: "Malformed", prompt: "Inspect" },
        completedDependencies: [],
      })).rejects.toThrow("malformed tool call");
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects unknown tool names through the broker and returns a bounded error to the model", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "forge-agent-unknown-tool-"));
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [
            { id: "call_unknown", type: "function", function: { name: "run-shell", arguments: "{}" } },
          ] } }],
        }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: "The requested tool is unavailable; no command was executed." } }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);
      const policy = validatePermissionPolicy({ version: 1, mode: "restricted", allowedTools: ["read-file"] });
      const provider = new OpenAICompatibleProvider({
        apiKey: "test-secret", model: "test-model", workspacePath: workspace, permissionPolicy: policy,
      });
      await expect(provider.complete({
        task: { id: "unknown-tool", agent: "reviewer", title: "Unknown tool", prompt: "Try run-shell" },
        completedDependencies: [],
      })).resolves.toMatchObject({ content: expect.stringContaining("unavailable") });
      const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
      const toolMessage = secondBody.messages.find((message: { role: string }) => message.role === "tool");
      expect(toolMessage.content).toContain("Unknown workspace tool: run-shell");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects provider URLs containing embedded credentials, queries, or fragments", () => {
    for (const baseUrl of [
      "https://user:pass@example.com/v1",
      "https://api.example.com/v1?token=secret",
      "https://api.example.com/v1#fragment",
    ]) {
      expect(() => new OpenAICompatibleProvider({
        apiKey: "test-secret", model: "test-model", baseUrl,
      })).toThrow("must not contain credentials, a query string, or a fragment");
    }
  });

});
