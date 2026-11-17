import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  installationRecord,
  isValidInstallationId,
  redisCommand,
  verifyGitHubSignature,
  type GitHubInstallation,
  type InstallationRecord,
} from "../_lib/github-app";

export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 1024 * 1024) throw new Error("Payload too large");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

const key = (id: number) => `forge:github:installation:${id}`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const appId = Number(process.env.GITHUB_APP_ID);
  if (!secret || !Number.isSafeInteger(appId) || appId <= 0) {
    return res.status(503).json({ error: "GitHub App webhook is not configured" });
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(413).json({ error: "Webhook payload is too large or unreadable" });
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!verifyGitHubSignature(rawBody, Array.isArray(signature) ? signature[0] : signature, secret)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  let payload: {
    action?: string;
    installation?: GitHubInstallation;
  };
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  const event = req.headers["x-github-event"];
  if (typeof event !== "string") return res.status(400).json({ error: "Missing event header" });
  if (event !== "installation" && event !== "installation_repositories") {
    return res.status(200).json({ received: true, ignored: true });
  }

  const installation = payload.installation;
  if (!installation || !isValidInstallationId(installation.id)) {
    return res.status(400).json({ error: "Invalid installation payload" });
  }
  if (installation.app_id !== undefined && installation.app_id !== appId) {
    return res.status(403).json({ error: "Webhook belongs to a different GitHub App" });
  }

  try {
    const recordKey = key(installation.id);
    if (event === "installation" && payload.action === "deleted") {
      await redisCommand(["DEL", recordKey]);
      return res.status(200).json({ received: true, deleted: true });
    }

    const previous = await redisCommand<InstallationRecord | null>(["GET", recordKey]);
    const record = installationRecord(
      { ...installation, app_id: installation.app_id ?? appId },
      previous ?? undefined,
    );
    if (record.appId !== appId) {
      return res.status(403).json({ error: "Installation App ID mismatch" });
    }
    await redisCommand(["SET", recordKey, JSON.stringify(record)]);
    return res.status(200).json({ received: true, stored: true });
  } catch {
    return res.status(500).json({ error: "Could not persist installation event" });
  }
}
