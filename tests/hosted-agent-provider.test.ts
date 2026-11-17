import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedAgentProvider } from "../src/core/hosted-agent-provider.js";
import type { AgentRequest } from "../src/core/orchestrator.js";

const request: AgentRequest = {
  task: { id: "task-1", agent: "architect", title: "Review design", prompt: "Propose a design." },
  completedDependencies: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

});

describe("hosted agent provider security and protocol handling", () => {
  it("requires credentials for hosted providers", () => {
    expect(() => new HostedAgentProvider({ provider: "anthropic", model: "claude-sonnet" })).toThrow("requires an API key");
    expect(() => new HostedAgentProvider({ provider: "google", model: "gemini" })).toThrow("requires an API key");
  });

  it("rejects insecure non-local provider endpoints", () => {
    expect(() => new HostedAgentProvider({
      provider: "anthropic", model: "claude-sonnet", apiKey: "test-key", baseUrl: "http://api.example.com",
    })).toThrow("HTTPS");
  });

  it("allows local HTTP endpoints for local model servers", () => {
    expect(() => new HostedAgentProvider({ provider: "ollama", model: "llama3.2", baseUrl: "http://localhost:11434" })).not.toThrow();
  });

  it("allows IPv6 loopback HTTP for local model servers", () => {
    expect(() => new HostedAgentProvider({ provider: "ollama", model: "llama3.2", baseUrl: "http://[::1]:11434" })).not.toThrow();
  });

  it("sends Anthropic credentials and parses proposal text", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key");
      expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Design proposal" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HostedAgentProvider({ provider: "anthropic", model: "claude-sonnet", apiKey: "test-key" });
    const result = await provider.complete(request);
    expect(result.content).toBe("Design proposal");
    expect(result.provider).toBe("anthropic");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects redirects on credential-bearing provider requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Safe response" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HostedAgentProvider({ provider: "anthropic", model: "claude-test", apiKey: "test-key" });
    await expect(provider.complete(request)).resolves.toMatchObject({ content: "Safe response" });
  });

  it("rejects provider timeouts outside the supported range", async () => {
    const provider = new HostedAgentProvider({ provider: "ollama", model: "llama3.2", timeoutMs: 999 });
    await expect(provider.complete(request)).rejects.toThrow("between 1000 and 180000");
  });

  it("sends Google credentials and parses candidate text", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain(":generateContent");
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("google-test-key");
      const body = JSON.parse(String(init?.body)) as { systemInstruction?: { parts?: Array<{ text?: string }> }; contents?: Array<{ parts?: Array<{ text?: string }> }> };
      expect(body.systemInstruction?.parts?.[0]?.text).toContain("proposal only");
      expect(body.contents?.[0]?.parts?.[0]?.text).toContain("Propose a design.");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Google proposal" }] } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HostedAgentProvider({ provider: "google", model: "gemini-test", apiKey: "google-test-key" });
    const result = await provider.complete(request);
    expect(result.content).toBe("Google proposal");
    expect(result.provider).toBe("google");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends Ollama chat requests and parses message content", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost:11434/api/chat");
      const body = JSON.parse(String(init?.body)) as { stream?: boolean; messages?: Array<{ role: string; content: string }> };
      expect(body.stream).toBe(false);
      expect(body.messages?.[0]?.role).toBe("system");
      expect(body.messages?.[0]?.content).toContain("proposal only");
      return new Response(JSON.stringify({ message: { content: "Local proposal" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HostedAgentProvider({ provider: "ollama", model: "llama-test" });
    const result = await provider.complete(request);
    expect(result.content).toBe("Local proposal");
    expect(result.provider).toBe("ollama");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports non-success provider responses without exposing response bodies", async () => {
    const fetchMock = vi.fn(async () => new Response("sensitive upstream detail", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HostedAgentProvider({ provider: "anthropic", model: "claude-test", apiKey: "test-key" });
    await expect(provider.complete(request)).rejects.toThrow("HTTP 429");
    expect(fetchMock).toHaveBeenCalledOnce();
  });


  it("encodes Google model identifiers in the request path", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/models/model%2Fwith%20spaces:generateContent");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Encoded model response" }] } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HostedAgentProvider({ provider: "google", model: "model/with spaces", apiKey: "test-key" });
    await expect(provider.complete(request)).resolves.toMatchObject({ content: "Encoded model response" });
  });

  it("passes the configured timeout to the network request", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return new Response(JSON.stringify({ message: { content: "Timed request response" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HostedAgentProvider({ provider: "ollama", model: "llama-test", timeoutMs: 12_000 });
    await expect(provider.complete(request)).resolves.toMatchObject({ content: "Timed request response" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["anthropic", { content: ["not-a-content-block", { type: "image", source: {} }] }],
    ["google", { candidates: [{ content: { parts: [null, "not-a-part", { inlineData: {} }] } }] }],
    ["ollama", { message: ["not-a-message-object"] }],
    ["google", { candidates: [null, { content: "not-an-object" }] }],
  ] as const)("rejects malformed nested %s response structures safely", async (provider, payload) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), {
      status:  200, headers: { "content-type": "application/json" },
    })));
    const options = provider === "ollama"
      ? { provider, model: "test-model" } as const
      : { provider, model: "test-model", apiKey: "test-key" } as const;
    const instance = new HostedAgentProvider(options);
    await expect(instance.complete(request)).rejects.toThrow("empty assistant response");
  });

  it("rejects empty provider responses rather than returning a blank proposal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    })));
    const provider = new HostedAgentProvider({ provider: "anthropic", model: "claude-test", apiKey: "test-key" });
    await expect(provider.complete(request)).rejects.toThrow("empty assistant response");
  });


  it("applies the shared response-size limit to hosted provider responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(" ".repeat(1_048_577), {
      status: 200, headers: { "content-type": "application/json" },
    })));
    const provider = new HostedAgentProvider({ provider: "anthropic", model: "claude-test", apiKey: "test-key" });
    await expect(provider.complete(request)).rejects.toThrow("1 MiB size limit");
  });

  it("rejects malformed JSON from a successful hosted provider response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{ malformed", {
      status: 200, headers: { "content-type": "application/json" },
    })));
    const provider = new HostedAgentProvider({ provider: "google", model: "gemini-test", apiKey: "test-key" });
    await expect(provider.complete(request)).rejects.toThrow("malformed JSON");
  });


  it("does not automatically retry timed-out provider POST requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HostedAgentProvider({
      provider: "google", model: "gemini-test", apiKey: "test-key", timeoutMs: 1_000,
    });
    await expect(provider.complete(request)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry transient HTTP 5xx responses automatically", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HostedAgentProvider({ provider: "ollama", model: "llama-test" });
    await expect(provider.complete(request)).rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects provider URLs containing embedded credentials, queries, or fragments", () => {
    for (const baseUrl of [
      "https://user:pass@example.com",
      "https://api.example.com?token=secret",
      "https://api.example.com#fragment",
    ]) {
      expect(() => new HostedAgentProvider({
        provider: "anthropic", model: "claude-test", apiKey: "test-key", baseUrl,
      })).toThrow("must not contain credentials, a query string, or a fragment");
    }
  });

});
