import type { VercelRequest, VercelResponse } from "../_lib/vercel-types.js";
import { getQuery, readSession } from "../_lib/github-auth.js";
import { isValidInstallationId } from "../_lib/github-app.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const rawId = getQuery(req, "installation_id");
  const id = rawId === undefined ? NaN : Number(rawId);
  if (!isValidInstallationId(id)) {
    return res.status(400).json({ error: "Missing or invalid installation ID" });
  }
  try {
    const session = await readSession(req);
    // A user may install the App after an earlier sign-in. Re-authorize so
    // GitHub's current /user/installations response remains the authority.
    if (!session || !session.installationIds.includes(id)) {
      return res.redirect(302, `/api/github/login?installation_id=${id}`);
    }
    return res.redirect(302, "/?github=connected");
  } catch {
    return res.status(503).json({ error: "Could not verify the GitHub installation" });
  }
}
