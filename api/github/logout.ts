import type { VercelRequest, VercelResponse } from "../_lib/vercel-types.js";
import { clearSessionCookie, getCookie, sessionKey } from "../_lib/github-auth.js";
import { redisCommand } from "../_lib/github-app.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  try {
    const id = getCookie(req, "forge_github_session");
    if (id && /^[A-Za-z0-9_-]{40,60}$/.test(id)) await redisCommand(["DEL", sessionKey(id)]);
    clearSessionCookie(res);
    return res.status(200).json({ signedOut: true });
  } catch {
    clearSessionCookie(res);
    return res.status(503).json({ error: "Could not end the session" });
  }
}
