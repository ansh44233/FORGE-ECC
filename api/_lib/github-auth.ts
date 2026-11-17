import { createHash, randomBytes } from "node:crypto";
import type { VercelRequest, VercelResponse } from "./vercel-types";
import { isValidInstallationId, parseInstallationRecord, redisCommand, type InstallationRecord } from "./github-app";

const STATE_TTL_SECONDS = 600;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const COOKIE_NAME = "forge_github_session";
const API_VERSION = "2022-11-28";

export type OAuthState = { verifier: string; installationId: number | null };
export type AuthSession = { userId: number; login: string; installationIds: number[]; createdAt: number };

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
export function stateKey(state: string): string { return `forge:github:oauth-state:${state}`; }
export function sessionKey(id: string): string { return `forge:github:session:${id}`; }
export function getCookie(req: VercelRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  const cookie = Array.isArray(raw) ? raw[0] : raw;
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}
export function setSessionCookie(res: VercelResponse, id: string): void {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`);
}
export function clearSessionCookie(res: VercelResponse): void {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
export async function readSession(req: VercelRequest): Promise<AuthSession | undefined> {
  const id = getCookie(req, COOKIE_NAME);
  if (!id || !/^[A-Za-z0-9_-]{40,60}$/.test(id)) return undefined;
  const stored = await redisCommand<string | null>(["GET", sessionKey(id)]);
  if (!stored) return undefined;
  try {
    const value = JSON.parse(stored) as AuthSession;
    if (!Number.isSafeInteger(value.userId) || value.userId <= 0 ||
        typeof value.login !== "string" || !Array.isArray(value.installationIds) ||
        !value.installationIds.every(isValidInstallationId)) return undefined;
    return value;
  } catch { return undefined; }
}
export async function createSession(session: AuthSession): Promise<string> {
  const id = randomToken();
  await redisCommand(["SET", sessionKey(id), JSON.stringify(session), "EX", SESSION_TTL_SECONDS]);
  return id;
}
export async function getVerifiedInstallations(ids: number[]): Promise<InstallationRecord[]> {
  const records: InstallationRecord[] = [];
  for (const id of ids.slice(0, 100)) {
    const raw = await redisCommand<string | null>(["GET", `forge:github:installation:${id}`]);
    const record = parseInstallationRecord(raw);
    if (record && record.installationId === id && record.appId === Number(process.env.GITHUB_APP_ID) && !record.suspendedAt) {
      records.push(record);
    }
  }
  return records;
}
export function getQuery(req: VercelRequest, key: string): string | undefined {
  const value = req.query?.[key];
  return typeof value === "string" ? value : undefined;
}
export function oauthConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const appId = Number(process.env.GITHUB_APP_ID);
  const callbackUrl = process.env.GITHUB_CALLBACK_URL ?? "https://forge-ecc.vercel.app/api/github/callback";
  if (!clientId || !clientSecret || !Number.isSafeInteger(appId) || appId <= 0 ||
      callbackUrl !== "https://forge-ecc.vercel.app/api/github/callback") {
    throw new Error("GitHub OAuth configuration is incomplete or callback URL is not the approved production URL");
  }
  return { clientId, clientSecret, appId, callbackUrl };
}
export async function githubApi<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "FORGE-Workbench",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GitHub API request failed: ${response.status}`);
  return await response.json() as T;
}
export function jsonError(res: VercelResponse, status: number, message: string) {
  return res.status(status).json({ error: message });
}
