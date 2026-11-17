import { describe, expect, it } from "vitest";
import { buildClaudeCodeArgs, parseClaudeCodeOutput } from "../src/ai/claude-code-provider.js";
import { createAIProvider, readAIProviderConfig } from "../src/ai/provider.js";

describe("Claude Code harness adapter", () => {
  it("selects Claude Code without requiring an Anthropic API key", () => {
    expect(readAIProviderConfig({ FORGE_AI_PROVIDER: "claude-code" }).provider).toBe("claude-code");
  });

  it("builds a bounded plan-mode invocation and denies write and shell tools", () => {
    const args = buildClaudeCodeArgs("Review this change", "sonnet");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("Bash");
    expect(args).toContain("Edit");
    expect(args).toContain("Write");
    expect(args).toContain("--max-turns");
    expect(args).toContain("3");
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
  });

  it("parses successful JSON output", () => {
    expect(parseClaudeCodeOutput(JSON.stringify({
      result: "Review complete",
      session_id: "session-123",
    }))).toEqual({ text: "Review complete", sessionId: "session-123" });
  });

  it("rejects malformed or unsuccessful output", () => {
    expect(() => parseClaudeCodeOutput("not json")).toThrow("invalid JSON");
    expect(() => parseClaudeCodeOutput(JSON.stringify({ is_error: true, result: "Authentication failed" })))
      .toThrow("Authentication failed");
  });

  it("registers the Claude Code provider through the shared factory", () => {
    expect(createAIProvider({ provider: "claude-code" }).id).toBe("claude-code");
  });
});
