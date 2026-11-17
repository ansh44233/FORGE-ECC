import type { VercelRequest, VercelResponse } from "../_lib/vercel-types";
import { getQuery, readSession } from "../_lib/github-auth";
import { isValidInstallationId } from "../_lib/github-app";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const rawId = getQuery(req, "installation_id");
  const id = rawId === undefined ? NaN : Number(rawId);
  if (!isValidInstallationId(id)) return res.status(400).json({ error: "Missing or invalid installation ID" });
  try {
    const session = await readSession(req);
    if (!session) return res.redirect(302, `/api/github/login?installation_id=${id}`);
    if (!session.installationIds.includes(id)) {
      return res.status(403).json({ error: "This GitHub account is not authorized for the selected installation. Sign in with the account that can access it." });
    }
    return res.redirect(302, "/?github=connected");
  } catch {
    return res.status(503).json({ error: "Could not verify the GitHub installation" });
  }
}
