import { describe, expect, it } from "vitest";
import { discardProviderResponse, readProviderJson } from "../src/core/provider-response.js";

describe("bounded provider response parsing", () => {
  it("parses valid JSON within the configured byte limit", async () => {
    const response = new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    await expect(readProviderJson(response, 128)).resolves.toMatchObject({
      choices: [{ message: { content: "ok" } }],
    });
  });

  it("rejects a response whose declared content length exceeds the limit", async () => {
    const response = new Response("{}", { headers: { "content-length": "2048" } });
    await expect(readProviderJson(response, 32)).rejects.toThrow("1 MiB size limit");
  });

  it("rejects a streamed response that exceeds the limit without a content length", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(24));
        controller.enqueue(new Uint8Array(24));
        controller.close();
      },
    }));
    await expect(readProviderJson(response, 32)).rejects.toThrow("1 MiB size limit");
  });

  it("rejects malformed JSON with a bounded, non-sensitive error", async () => {
    await expect(readProviderJson(new Response("{not-json"))).rejects.toThrow("malformed JSON");
  });

  it("cancels unread provider error bodies without reading their contents", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status: 500 });
    await discardProviderResponse(response);
    expect(cancelled).toBe(true);
  });

  it("rejects an absent response body", async () => {
    const response = new Response(null);
    await expect(readProviderJson(response)).rejects.toThrow("empty response body");
  });
});
