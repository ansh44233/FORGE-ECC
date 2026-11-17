import type { VercelRequest, VercelResponse } from "../_lib/vercel-types";
import { createSession, getQuery, githubApi, oauthConfig, readSession, setSessionCookie, stateKey, type AuthSession, type OAuthState } from "../_lib/github-auth";
import { isValidInstallationId, installationRecord, redisCommand, type GitHubInstallation } from "../_lib/github-app";

type TokenResponse = { access_token?: string; error?: string };
type GitHubUser = { id: number; login: string };
type InstallationPage = { installations: GitHubInstallation[] };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const oauthError = getQuery(req, "error");
  if (oauthError) return res.redirect(302, "/?github=authorization_cancelled");
  const code = getQuery(req, "code");
  const state = getQuery(req, "state");
  if (!code || code.length > 512 || !state || !/^[A-Za-z0-9_-]{40,60}$/.test(state)) {
    return res.status(400).json({ error: "Invalid GitHub authorization response" });
  }

  try {
    const stored = await redisCommand<string | null>(["GETDEL", stateKey(state)]);
    if (!stored) return res.status(400).json({ error: "Sign-in state expired or already used. Please try again." });
    const oauthState = JSON.parse(stored) as OAuthState;
    if (typeof oauthState.verifier !== "string" || oauthState.verifier.length < 43 ||
        (oauthState.installationId !== null && !isValidInstallationId(oauthState.installationId))) {
      return res.status(400).json({ error: "Invalid sign-in state" });
    }
    const { clientId, clientSecret, callbackUrl, appId } = oauthConfig();
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl, code_verifier: oauthState.verifier }),
      cache: "no-store",
    });
    if (!tokenResponse.ok) throw new Error("OAuth token exchange failed");
    const tokenPayload = await tokenResponse.json() as TokenResponse;
    if (!tokenPayload.access_token || tokenPayload.error) return res.status(401).json({ error: "GitHub authorization was not completed" });
    const token = tokenPayload.access_token;

    const user = await githubApi<GitHubUser>("/user", token);
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.login !== "string") {
      return res.status(502).json({ error: "Could not verify GitHub account" });
    }

    const installations: GitHubInstallation[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await githubApi<InstallationPage>(`/user/installations?per_page=100&page=${page}`, token);
      const current = result.installations ?? [];
      installations.push(...current.filter(item => item.app_id === appId && isValidInstallationId(item.id)));
      if (current.length < 100) break;
    }
    const accessibleIds = [...new Set(installations.map(item => item.id))];
    if (oauthState.installationId !== null && !accessibleIds.includes(oauthState.installationId)) {
      return res.status(403).json({ error: "This GitHub account does not have access to the selected FORGE installation. Sign in with an authorized account." });
    }

    for (const item of installations) {
      const record = installationRecord({ ...item, app_id: appId });
      await redisCommand(["SET", `forge:github:installation:${item.id}`, JSON.stringify(record)]);
    }

    const session: AuthSession = { userId: user.id, login: user.login, installationIds: accessibleIds, createdAt: Date.now() };
    const sessionId = await createSession(session);
    setSessionCookie(res, sessionId);
    return res.redirect(302, "/?github=connected");
  } catch {
    return res.status(502).json({ error: "GitHub sign-in failed. Please try again." });
  }
}
