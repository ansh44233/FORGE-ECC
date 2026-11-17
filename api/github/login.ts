import type { VercelRequest, VercelResponse } from "../_lib/vercel-types";
import { getQuery, oauthConfig, pkceChallenge, randomToken, redisCommand, stateKey, type OAuthState } from "../_lib/github-auth";
import { isValidInstallationId } from "../_lib/github-app";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  try {
    const { clientId, callbackUrl } = oauthConfig();
    const rawId = getQuery(req, "installation_id");
    const installationId = rawId === undefined ? null : Number(rawId);
    if (rawId !== undefined && (!isValidInstallationId(installationId) || !Number.isSafeInteger(installationId))) {
      return res.status(400).json({ error: "Invalid installation ID" });
    }
    const state = randomToken();
    const verifier = randomToken(48);
    const record: OAuthState = { verifier, installationId };
    await redisCommand(["SET", stateKey(state), JSON.stringify(record), "EX", 600]);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("allow_signup", "false");
    return res.redirect(302, url.toString());
  } catch {
    return res.status(503).json({ error: "GitHub sign-in is not configured" });
  }
}
