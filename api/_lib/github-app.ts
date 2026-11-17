import { createHmac, timingSafeEqual } from "node:crypto";

export type GitHubInstallation = {
  id: number;
  app_id?: number;
  account?: { id?: number; login?: string; type?: string } | null;
  target_type?: string;
  repository_selection?: string;
  suspended_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type InstallationRecord = {
  installationId: number;
  appId: number;
  account: { id: number | null; login: string | null; type: string | null };
  targetType: string | null;
  repositorySelection: string | null;
  suspendedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export function verifyGitHubSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"),
  );
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function isValidInstallationId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function installationRecord(
  installation: GitHubInstallation,
  previous?: InstallationRecord,
): InstallationRecord {
  const account = installation.account;
  return {
    installationId: installation.id,
    appId: installation.app_id ?? previous?.appId ?? 0,
    account: {
      id: account?.id ?? previous?.account.id ?? null,
      login: account?.login ?? previous?.account.login ?? null,
      type: account?.type ?? previous?.account.type ?? null,
    },
    targetType: installation.target_type ?? previous?.targetType ?? null,
    repositorySelection:
      installation.repository_selection ?? previous?.repositorySelection ?? null,
    suspendedAt:
      installation.suspended_at === undefined
        ? previous?.suspendedAt ?? null
        : installation.suspended_at,
    createdAt: installation.created_at ?? previous?.createdAt ?? null,
    updatedAt: installation.updated_at ?? previous?.updatedAt ?? null,
  };
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Redis REST configuration is missing");
  return { url: url.replace(/\/$/, ""), token };
}

export async function redisCommand<T = unknown>(command: unknown[]): Promise<T> {
  const { url, token } = redisConfig();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Redis request failed: ${response.status}`);
  const payload = (await response.json()) as { result?: T; error?: string };
  if (payload.error) throw new Error(payload.error);
  return payload.result as T;
}
