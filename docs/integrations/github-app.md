# GitHub App integration foundation

This branch adds the first server-side foundation for the FORGE GitHub App.

## Endpoints

- `GET /api/github/health` reports whether required environment variables are present.
- `GET /api/github/install` redirects to the configured GitHub App installation page.
- `POST /api/github/webhook` verifies GitHub's `X-Hub-Signature-256` header and persists installation metadata.

## Vercel environment variables

Configure these in the Vercel project settings. Never commit or share their values:

- `GITHUB_APP_SLUG`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `KV_REST_API_URL` (or `UPSTASH_REDIS_REST_URL`)
- `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_TOKEN`)

The Redis token must have write access because installation webhook events create, update, and delete records.

## GitHub App configuration

Use the webhook URL `https://forge-ecc.vercel.app/api/github/webhook` and subscribe to the `installation` and `installation_repositories` events. The initial permission scope should remain least-privilege: repository Metadata read-only and Contents read-only.

## Security boundary and current limitations

- Webhook signatures are checked against the raw request body before JSON parsing.
- Installation records contain only installation/account metadata, not private keys, tokens, or repository contents.
- The webhook checks the installation's app ID when GitHub includes it in the payload.
- An installation ID by itself is not proof of user identity or authorization.
- User sign-in, user-to-installation ownership checks, installation access-token creation, repository browsing/scanning, and pull-request workflows are not implemented by this foundation.
- Do not expose stored installation records or mint installation tokens to a browser until authenticated-user authorization is implemented.
