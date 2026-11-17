import type { VercelRequest, VercelResponse } from "../_lib/vercel-types";

function configured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_SLUG &&
      process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_WEBHOOK_SECRET &&
      (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
      (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
  );
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(503).json({ error: "GitHub App setup is incomplete" });
  }
  if (!configured()) {
    return res.status(503).json({ error: "GitHub App backend configuration is incomplete" });
  }
  return res.redirect(302, `https://github.com/apps/${slug}/installations/new`);
}
