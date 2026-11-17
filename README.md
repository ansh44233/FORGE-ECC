<div align="center">

# FORGE — Engineering Workbench

**Understand your codebase. Coordinate AI-assisted work. Review changes. Verify outcomes.**

[![CI](https://github.com/ansh44233/FORGE-ECC/actions/workflows/ci.yml/badge.svg)](https://github.com/ansh44233/FORGE-ECC/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v1.0.0-64748b)](https://github.com/ansh44233/FORGE-ECC/releases/tag/v1.0.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933)](https://nodejs.org/)

[Website](https://forge-ecc.vercel.app/) · [Source](https://github.com/ansh44233/FORGE-ECC) · [Organization](https://github.com/forge-workbench) · [Releases](https://github.com/ansh44233/FORGE-ECC/releases) · [Issues](https://github.com/ansh44233/FORGE-ECC/issues)

</div>

> FORGE is an open-source, local-first engineering workbench. The public website is the product and project information site; the full interactive dashboard runs locally against a workspace you choose. A hosted GitHub App installation flow is not yet shipped.

## Contents

- [Overview](#overview)
- [Product capabilities](#product-capabilities)
- [Architecture](#architecture)
- [Technology](#technology)
- [AI providers and editor integrations](#ai-providers-and-editor-integrations)
- [Install and run](#install-and-run)
- [Dashboard](#dashboard)
- [MCP server](#mcp-server)
- [GitHub Action](#github-action)
- [Security model](#security-model)
- [Repository layout](#repository-layout)
- [How FORGE is built](#how-forge-is-built)
- [Project, organization and contributors](#project-organization-and-contributors)
- [Development](#development)
- [Roadmap and current boundaries](#roadmap-and-current-boundaries)
- [License](#license)

## Overview

FORGE (Engineering Workbench / Engineering Control Center) brings software-project intelligence and AI-assisted engineering workflows into one inspectable workspace. It combines static repository analysis, architecture and dependency mapping, change review, agent configuration, provider routing, workflow orchestration, approval records, verification, experiments and security diagnostics.

The intended engineering loop is:

```text
discover → inspect → map → plan → implement → review → verify → learn
```

FORGE is designed to make the evidence behind an engineering decision visible. It does not treat an AI-generated suggestion as an approved change, and it keeps patch validation, approval, staging, verification and promotion as distinct steps.

## Product capabilities

| Area | What it does |
|---|---|
| Project intelligence | Detects project structure, languages, manifests, scripts and source inventory |
| Code intelligence | Searches supported source files and extracts bounded code context |
| Architecture | Builds dependency and import maps and highlights potential impact |
| Git intelligence | Inspects working-tree changes and revision comparisons |
| Quality and risk | Produces quality findings, project-health signals and engineering-risk summaries |
| Agent registry | Organizes agents, skills, hooks and workspace context |
| Provider routing | Routes proposal-oriented work through supported local or API providers |
| Workflow orchestration | Plans tasks, records runs and exposes task/run history |
| Human approval | Separates patch validation and approval from staging and promotion |
| Verification | Runs explicitly selected checks and stores verification history |
| Experiments | Compares provider/model configurations using repeatable evaluation suites |
| Security audit | Audits supported agent configuration files with bounded, read-only checks |
| Local dashboard | Provides a browser-based control center for the selected local workspace |
| MCP tools | Exposes bounded, read-only workspace inspection tools to compatible clients |
| GitHub Action | Runs repository inspection, quality, health and review operations in CI |

The project-health score and risk signals are prioritization aids, not security certifications or proof that a repository is defect-free.

## Architecture

FORGE is a TypeScript Node.js application organized around a CLI entry point and focused core modules.

```text
Developer / CI
    │
    ├── forge CLI ─────────────── src/cli.ts
    │       │
    │       ├── Project and code intelligence
    │       ├── Architecture / dependency analysis
    │       ├── Git / quality / risk analysis
    │       ├── Agent registry and orchestration
    │       ├── Review, approval and verification
    │       └── Run, experiment and history stores
    │
    ├── Local dashboard ───────── src/core/dashboard-server.ts
    │       └── Browser UI served for a selected local workspace
    │
    ├── MCP server ────────────── src/mcp/server.ts
    │       └── Bounded read-only workspace tools
    │
    └── GitHub Action ─────────── action.yml
            └── CI operations: inspect / quality / health / review
```

### Main boundaries

- **CLI:** the primary interface for initializing and inspecting projects, starting the dashboard, running checks and managing local workflow records.
- **Core modules:** implement project analysis, orchestration, review, verification, policy enforcement and persistence as separate units.
- **Dashboard server:** serves the actual local dashboard and binds to loopback. It is not the same application as the static public website.
- **MCP server:** provides bounded workspace tools to external MCP clients. The current MCP surface is read-only.
- **GitHub Action:** packages selected CLI operations for CI workflows.
- **Workspace state:** project-specific history, configuration and experiment records are kept under the workspace's `.forge/` directory.

## Technology

| Technology | Role |
|---|---|
| Node.js 22+ | Runtime |
| TypeScript | Application implementation and type checking |
| npm | Dependency and build workflow |
| Vitest | Automated unit and integration tests |
| Model Context Protocol SDK | MCP server and tool protocol |
| Zod | Runtime input/schema validation |
| GitHub Actions | CI, release automation and reusable Action |
| Vercel | Static public product website hosting |

The application is an ES module TypeScript project. The build compiles `src/` into `dist/`; the CLI is exposed as the `forge` executable.

## AI providers and editor integrations

FORGE distinguishes **model/provider adapters** from **editor clients**. An editor that connects over MCP is not a native editor extension.

| Tool or provider | Current integration |
|---|---|
| Claude Code CLI | Local authenticated CLI provider adapter; proposal-oriented run path |
| Claude Code MCP client | Can connect to the local FORGE stdio MCP server |
| Cursor | Can connect to the same local MCP server through Cursor MCP configuration |
| OpenAI-compatible API | Provider adapter; bounded native read-only tool loop is supported for OpenAI |
| Anthropic API | Provider adapter; normal run path is proposal-only |
| Google AI | Provider adapter; normal run path is proposal-only |
| Ollama | Local model endpoint adapter; normal run path is proposal-only |
| GitHub Actions | Shipped composite Action |
| Native Cursor/VS Code/OpenCode extension | Not shipped |
| One-click GitHub App | Not shipped; registration and hosted installation backend remain future work |

### Claude Code

The local Claude Code provider adapter uses the authenticated Claude Code CLI. It is separate from configuring an Anthropic API key. See [Claude Code integration notes](docs/integrations/claude-code.md).

### Cursor

Cursor can act as an MCP client for FORGE's local stdio MCP server. Configure the server in the Cursor project's `.cursor/mcp.json` (or supported user-level MCP configuration) and point it to the FORGE MCP launch command. This is MCP interoperability, not a dedicated Cursor plugin.

See [Cursor's MCP documentation](https://docs.cursor.com/context/mcp) and the [FORGE MCP section](#mcp-server).

### Provider setup

See [docs/providers.md](docs/providers.md) for provider configuration and behavior. Provider credentials are supplied by the developer in their own environment; do not commit API keys or tokens.

## Install and run

**Requirements:** Node.js 22 or newer, npm, and Git.

### Install the released CLI from GitHub

```bash
npm install --global git+https://github.com/ansh44233/FORGE-ECC.git#v1.0.0
forge --version
forge init ./my-project
forge inspect ./my-project
forge dashboard ./my-project
```

The dashboard command prints a local URL. Open it in your browser. FORGE operates on the project path you provide and stores local project history under `.forge/`.

### Build from source

```bash
git clone https://github.com/ansh44233/FORGE-ECC.git
cd FORGE-ECC
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

### Common commands

```bash
# Initialize and inspect a workspace
forge init ./my-project
forge inspect ./my-project

# Start the browser dashboard
forge dashboard ./my-project

# Run the read-only agent configuration audit
forge agent-security ./my-project
forge agent-security ./my-project --json

# Start the stdio MCP server for a workspace
FORGE_WORKSPACE=/absolute/path/to/my-project npm run mcp
```

Use `forge --help` and the command-specific help output for the full CLI command list and options.

## Dashboard

The full engineering dashboard is served locally by `forge dashboard ./your-project`. It is not the static landing page at [forge-ecc.vercel.app](https://forge-ecc.vercel.app/).

The dashboard brings together the project's health and architecture views, agent registry and configuration, workflow/run activity, approvals, reviews, verification, traces, regression/evaluation history and workspace browsing. The exact data shown depends on the selected local workspace and the records available there.

**Privacy boundary:** the local dashboard is intended to operate against the workspace on the machine where it is running. The public Vercel site is a separate static site and does not host this local workspace dashboard.

## MCP server

Build FORGE, then launch the stdio MCP server with an explicit workspace:

```bash
npm run build
FORGE_WORKSPACE=/absolute/path/to/project npm run mcp
```

The server exposes bounded, read-only tools for:

- Project inspection and source inventory
- Architecture mapping
- Code search
- Quality auditing
- Git change intelligence
- Specialist/agent discovery
- Review-plan creation
- Workspace browsing

The workspace broker resolves paths beneath `FORGE_WORKSPACE`. Hidden paths, generated/dependency directories, secret-like filenames and symlinks are excluded or rejected. File reads and search results are bounded. Review-plan creation records a draft; it does not execute the workflow.

The MCP surface does not provide shell access, arbitrary network access, project-file writes, patch application or test execution. The three workspace browsing/search tools require an explicit restricted-mode allowlist in `.forge/permissions.json`; the default proposal-only policy denies them.

### Example client configuration

For a local project, configure the MCP client to launch the built server with the project path in its environment. The exact JSON wrapper differs by client; Cursor supports project-level `.cursor/mcp.json`. Use the absolute path to the FORGE checkout/build and an absolute workspace path.

## GitHub Action

FORGE ships a composite Action for CI. Example:

```yaml
name: FORGE checks

on:
  pull_request:
  push:
    branches: [main]

jobs:
  forge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ansh44233/FORGE-ECC@v1.0.0
        with:
          version: v1.0.0
          project-path: .
          operation: inspect
```

Supported operations are `inspect`, `quality`, `health` and `review`. Pin production workflows to a reviewed release tag or immutable commit SHA. See [action.yml](action.yml) for inputs and defaults.

## Security model

FORGE includes explicit boundaries intended to make automation inspectable:

- Agent-configuration auditing is static, bounded and read-only.
- Credential-like matches are redacted from audit output.
- Symlinks and out-of-workspace paths are rejected by bounded workspace readers.
- Permission policies fail closed when malformed or unsupported.
- Patch validation is a dry run; approval records bind to patch and source fingerprints.
- Staging is separate from promotion. Approval does not itself modify project files.
- Verification runs only a named check selected by the operator.
- Docker-backed staged verification is opt-in and has documented runtime assumptions.
- AI review can send selected source excerpts to the provider configured by the developer.
- Local script verification executes project-controlled code on the host; it is not an OS sandbox.

Read [SECURITY.md](SECURITY.md) before using FORGE with untrusted repositories, agent instructions or project scripts. The security audit is a static heuristic and not a security certification.

## Repository layout

```text
FORGE-ECC/
├── .forge/
│   └── evals/                    # Built-in evaluation suite data
├── .github/
│   ├── workflows/                # CI, release and sandbox workflow definitions
│   └── dependabot.yml            # Dependency update configuration
├── docs/
│   ├── integrations/
│   │   └── claude-code.md        # Claude Code provider/client integration
│   ├── providers.md              # Provider configuration and behavior
│   └── FORGE-CAPABILITY-ROADMAP.md
├── public/
│   ├── index.html                # Static product website
│   ├── forge-mark.svg            # Brand mark
│   ├── forge-workbench.svg       # Brand/marketing artwork
│   └── forge-background.png      # Website background asset
├── src/
│   ├── ai/                       # AI provider adapters
│   ├── core/                     # Engineering intelligence and workbench modules
│   ├── mcp/                      # MCP server and workspace path policy
│   └── cli.ts                    # CLI entry point
├── tests/                        # Unit and integration test suite
├── action.yml                    # Reusable GitHub composite Action
├── package.json                  # Package metadata and scripts
├── package-lock.json             # Locked dependency graph
├── tsconfig.json                 # TypeScript compiler configuration
├── vercel.json                   # Static Vercel build configuration
├── CHANGELOG.md                  # Release history
├── CONTRIBUTING.md               # Contribution guide
├── LICENSE                       # MIT license
├── README.md                     # Project documentation
└── SECURITY.md                   # Security reporting and usage guidance
```

### Core module map

The `src/core/` directory is intentionally split by responsibility. Key groups include:

- **Project and code intelligence:** `project-inspector`, `project-health`, `code-intelligence`, `code-search`, `architecture-map`, `dependency-graph`, `dependency-impact`.
- **Git, review and quality:** `git-intelligence`, `change-intelligence`, `code-review`, `ai-code-review`, `review-planner`, `quality-audit`, `engineering-risk`.
- **Agents and orchestration:** `agent-registry`, `agent-workspace-context`, `skill-registry`, `hook-engine`, `orchestrator`, `model-router`, `workflow-store`.
- **Permissions and patch lifecycle:** `permission-policy`, `patch-validation`, `patch-approval`, `patch-application`, `workspace-tool-broker`.
- **Verification and sandboxing:** `verification`, `staged-verification`, `container-sandbox`, `sandbox-policy`, `sandbox-runtime`, `sandbox-compliance`, `sandbox-lifecycle`.
- **History and evaluation:** `run-store`, `run-replay`, `execution-trace`, `verification-history`, `review-history`, `benchmark-engine`, `benchmark-matrix`, `evaluation-engine`, `agent-experiment-studio`.
- **Security:** `agent-security-audit` and the permission/workspace policy modules.

Tests are organized by core module and include integration coverage for MCP protocol behavior, provider orchestration and container verification.

## How FORGE is built

The repository history shows an iterative, test-backed development process:

1. **Core workbench:** implement the CLI, project inspection, analysis modules and local workspace state.
2. **Engineering intelligence:** add architecture/dependency analysis, Git-aware review, quality/risk signals and verification.
3. **Agent workflow layer:** add registries, skills, hooks, provider routing, orchestration and experiment history.
4. **Safety and auditability:** add permission-policy checks, patch approval/staging, bounded workspace access, security auditing and sandbox diagnostics.
5. **Developer distribution:** package the CLI, add a reusable GitHub Action, CI/release workflows and the static product website.
6. **Documentation and integrations:** document provider behavior, Claude Code CLI usage and MCP compatibility with clients such as Cursor.

The project uses TypeScript modules, focused Vitest suites and GitHub Actions CI. Changes to core behavior are accompanied by tests; release automation checks package/tag consistency.

## Project, organization and contributors

**Project:** [FORGE-ECC](https://github.com/ansh44233/FORGE-ECC)  
**Organization / brand:** [FORGE WORKBENCH](https://github.com/forge-workbench)  
**Organization profile:** [What FORGE WORKBENCH builds](https://github.com/forge-workbench/.github/blob/main/profile/README.md)  
**Website:** [forge-ecc.vercel.app](https://forge-ecc.vercel.app/)

The public repository commit history currently credits **Ansh** (GitHub: [@ansh44233](https://github.com/ansh44233)) as the project author/maintainer. The repository does not currently publish a verified staff roster or role list, so this README does not invent one. Additional contributors should be credited from merged commits and verified repository contribution records.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Useful scripts:

| Script | Purpose |
|---|---|
| `npm run dev` | Run the TypeScript CLI during development |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm run typecheck` | Run TypeScript checks without emitting files |
| `npm test` | Run the Vitest suite |
| `npm run mcp` | Start the built MCP server |

Before opening a pull request:

- Add or update tests for behavior changes.
- Document security and permission implications.
- Do not commit credentials, tokens, private keys or local workspace data.
- Keep read-only analysis separate from operations that modify project files.
- Run type checking, tests and the production build.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## Roadmap and current boundaries

The current product is local-first. A hosted GitHub App with repository selection, installation callbacks, webhook processing and secure installation-token handling is **not yet implemented**. The GitHub Action is available today and is separate from a GitHub App.

Native IDE extensions, hosted team workspaces and write-capable MCP tools are also not implied by the current MCP integration. They require separate implementations and security reviews.

For planned capabilities, see [docs/FORGE-CAPABILITY-ROADMAP.md](docs/FORGE-CAPABILITY-ROADMAP.md).

## Project links

- [Website](https://forge-ecc.vercel.app/)
- [FORGE WORKBENCH organization](https://github.com/forge-workbench)
- [Source repository](https://github.com/ansh44233/FORGE-ECC)
- [Releases](https://github.com/ansh44233/FORGE-ECC/releases)
- [Issues](https://github.com/ansh44233/FORGE-ECC/issues)
- [CI workflows](https://github.com/ansh44233/FORGE-ECC/actions)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [License](LICENSE)

## License

FORGE is released under the [MIT License](LICENSE).
