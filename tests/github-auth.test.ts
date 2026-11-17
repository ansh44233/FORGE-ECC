import { describe, expect, it } from "vitest";
import { getCookie, getQuery, pkceChallenge, randomToken, stateKey, sessionKey } from "../api/_lib/github-auth";
import type { VercelRequest } from "../api/_lib/vercel-types";

function request(headers: VercelRequest["headers"], query?: VercelRequest["query"]): VercelRequest {
  return {
    headers,
    query,
    async *[Symbol.asyncIterator]() {},
  };
}

describe("GitHub OAuth helpers", () => {
  it("creates URL-safe random state and session identifiers", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,60}$/);
    expect(stateKey(token)).toBe(`forge:github:oauth-state:${token}`);
    expect(sessionKey(token)).toBe(`forge:github:session:${token}`);
  });

  it("creates a 43-character base64url S256 PKCE challenge", () => {
    const challenge = pkceChallenge("a-long-test-verifier-value-for-pkce");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("reads only the requested cookie and safely decodes it", () => {
    const req = request({ cookie: "other=one; forge_github_session=abc%2Fdef; theme=dark" });
    expect(getCookie(req, "forge_github_session")).toBe("abc/def");
    expect(getCookie(req, "missing")).toBeUndefined();
    expect(getCookie(request({ cookie: "forge_github_session=%E0%A4%A" }), "forge_github_session")).toBeUndefined();
  });

  it("reads only scalar query parameters", () => {
    expect(getQuery(request({}, { code: "abc" }), "code")).toBe("abc");
    expect(getQuery(request({}, { code: ["a", "b"] }), "code")).toBeUndefined();
  });
});
