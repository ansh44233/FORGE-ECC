# Contributing to FORGE

Thanks for considering a contribution.

## Before you start

1. Open an issue to discuss substantial changes.
2. Keep pull requests focused and explain the user problem they solve.
3. Do not include API keys, credentials, private project data, or generated secrets.

## Local checks

```bash
npm ci
npm test
npm run typecheck
npm run build
```

## Engineering expectations

- Prefer small modules with explicit inputs and outputs.
- Add tests for new behavior and bug fixes.
- Never claim a command or integration works without testing it.
- Treat project files as untrusted input.
- Require clear approval before destructive operations.
- Update documentation when behavior or limitations change.

By contributing, you agree that your contributions are provided under the project's MIT license.
