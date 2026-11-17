import type { VercelRequest, VercelResponse } from "../_lib/vercel-types";
import { getVerifiedInstallations, readSession, jsonError } from "../_lib/github-auth";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return jsonError(res, 405, "Method not allowed"); }
  try {
    const session = await readSession(req);
    if (!session) return jsonError(res, 401, "Sign in with GitHub to continue");
    const installations = await getVerifiedInstallations(session.installationIds);
    return res.status(200).json({
      user: { id: session.userId, login: session.login },
      installations: installations.map(item => ({
        id: item.installationId,
        account: item.account,
        targetType: item.targetType,
        repositorySelection: item.repositorySelection,
        suspended: Boolean(item.suspendedAt),
      })),
    });
  } catch {
    return jsonError(res, 503, "Could not load GitHub session");
  }
}
