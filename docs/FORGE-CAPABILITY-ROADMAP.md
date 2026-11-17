# FORGE Capability Roadmap

FORGE is the primary product. The separate ECC repository is a capability reference, not the codebase to rename or merge into FORGE.

## Product direction

Build an original, local-first agent engineering harness with FORGE-owned interfaces, data models, runtime, CLI, documentation, tests, and visual identity. Adopt useful capability patterns from the reference project, but do not bulk-copy its repository, branding, catalogs, or implementation. If a specific upstream implementation or text is intentionally reused, preserve the applicable license and attribution.

## Capability map

| Capability area | FORGE foundation today | FORGE direction |
| --- | --- | --- |
| Agents and specialist roles | Agent registry, orchestration, provider adapters | Expand role catalog, agent contracts, task routing, delegation and agent lifecycle |
| Skills and workflows | Skill registry, workspace Markdown skills, skill selection | Versioned skill packs, nested SKILL.md support, metadata validation, compatibility checks, install/update/list commands |
| Memory and context | Project memory, task context builder | Structured memory layers, retrieval, provenance, retention controls, secret/PII safeguards |
| Hooks and policies | Declarative before-agent hooks, permission policy | More lifecycle events, deterministic policy evaluation, audit logs and safe presets |
| Planning and execution | Dependency-aware run orchestration, approvals, resume | Reusable workflow templates, checkpoints, cancellation, durable per-task settlement and recovery |
| Quality and verification | Code review, quality audit, verification, regression intelligence | TDD workflows, independent review passes, verification profiles and evidence-linked reports |
| Security | Permission policy, sandbox policy, container sandbox, security review | Agent configuration scanning, prompt/config risk checks, supply-chain checks and security posture reports |
| Research and documentation | Code search, project inspection, dependency intelligence | Research-first workflows, source-backed technical research, docs lookup and architecture decision records |
| Integrations and harnesses | MCP server, provider adapters, CLI | Stable integration SDK and adapters for supported coding harnesses; publish a truthful support matrix |
| Learning and improvement | Evaluations, benchmarks, experiments, optimization recommendations | Evidence-based learning loop, reusable lessons, regression gates and human-approved config releases |
| Operator experience | CLI, local dashboard, traces and run history | Unified setup/doctor/status UX, inspectable activity timeline, export/import and migration tools |

## Delivery sequence

### Phase 1 — Foundation and compatibility
- Define stable schemas for agents, skills, hooks, memory, policies and workflow manifests.
- Make skill loading support both simple workspace Markdown files and nested SKILL.md packages.
- Add catalog validation, deterministic discovery, provenance and compatibility metadata.
- Add CLI commands for listing, validating and inspecting installed capabilities.
- Add fixtures and tests for malformed metadata, path traversal, symlinks and conflicting IDs.

### Phase 2 — Agent operating system
- Expand specialist agents and routing rules.
- Add reusable planning, implementation, review, verification and research workflows.
- Persist task-level outcomes as each task settles so interrupted batches lose less completed work.
- Add clear human approval gates for consequential actions.

### Phase 3 — Memory, hooks and security
- Add lifecycle hooks with fail-closed policy behavior.
- Add layered, searchable project memory with provenance and safe retention.
- Add security auditing for agent/skill/hook/MCP configuration and secrets exposure.
- Keep execution permissions narrower than descriptive agent instructions.

### Phase 4 — Integrations and operator UX
- Add supported harness adapters behind stable interfaces.
- Add setup, upgrade, doctor, status and compatibility reporting.
- Improve the dashboard around runs, approvals, memory, skills, traces and evaluation evidence.

### Phase 5 — Learning and release quality
- Turn verified outcomes into proposed lessons, never silent self-modification.
- Require repeatable evaluation evidence before promoting agent or skill configuration.
- Add regression gates, versioned releases, migration notes and reproducible release checks.

## Non-negotiable product rules

- FORGE owns its product identity and architecture.
- No feature is marked complete until implementation, tests and user-facing documentation agree.
- No live provider spend, credential use, destructive action or permission expansion without explicit authorization.
- Never describe a proposal as an executed change.
- Never describe host execution as sandboxed.
- Never claim a provider, harness or platform is supported without a tested compatibility path.
- Keep provenance for imported or adapted third-party material and honor its license.
