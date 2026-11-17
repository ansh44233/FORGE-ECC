import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  installationRecord,
  parseInstallationRecord,
  isValidInstallationId,
  verifyGitHubSignature,
} from "../api/_lib/github-app";

describe("GitHub App helpers", () => {
  it("verifies a valid GitHub SHA-256 webhook signature", () => {
    const body = Buffer.from('{"action":"created"}');
    const secret = "test-webhook-secret";
    const signature =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyGitHubSignature(body, signature, secret)).toBe(true);
    expect(verifyGitHubSignature(body, signature, "wrong-secret")).toBe(false);
  });

  it("rejects missing and malformed signatures", () => {
    expect(verifyGitHubSignature("{}", undefined, "secret")).toBe(false);
    expect(verifyGitHubSignature("{}", "sha1=bad", "secret")).toBe(false);
  });

  it("parses Redis JSON strings and preserves prior installation metadata", () => {
    const original = installationRecord({
      id: 123,
      app_id: 456,
      account: { id: 789, login: "sample-org", type: "Organization" },
      repository_selection: "selected",
    });
    const stored = JSON.stringify(original);
    const parsed = parseInstallationRecord(stored);
    expect(parsed).toEqual(original);

    const updated = installationRecord(
      { id: 123, suspended_at: "2026-11-17T00:00:00Z" },
      parsed,
    );
    expect(updated.account.login).toBe("sample-org");
    expect(updated.repositorySelection).toBe("selected");
  });

  it("returns undefined for a missing Redis record and rejects invalid JSON", () => {
    expect(parseInstallationRecord(null)).toBeUndefined();
    expect(() => parseInstallationRecord("{")).toThrow();
  });

  it("accepts only positive safe integer installation IDs", () => {
    expect(isValidInstallationId(123)).toBe(true);
    expect(isValidInstallationId(0)).toBe(false);
    expect(isValidInstallationId(-1)).toBe(false);
    expect(isValidInstallationId(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isValidInstallationId("123")).toBe(false);
  });

  it("normalizes safe installation metadata and preserves omitted fields", () => {
    const initial = installationRecord({
      id: 123,
      app_id: 456,
      account: { id: 789, login: "sample-org", type: "Organization" },
      repository_selection: "selected",
    });
    const updated = installationRecord(
      { id: 123, suspended_at: "2026-11-17T00:00:00Z" },
      initial,
    );
    expect(updated.appId).toBe(456);
    expect(updated.account.login).toBe("sample-org");
    expect(updated.repositorySelection).toBe("selected");
    expect(updated.suspendedAt).toBe("2026-11-17T00:00:00Z");
  });
});
