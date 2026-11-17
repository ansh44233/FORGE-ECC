<div align="center">

# FORGE — Engineering Workbench

**Understand your codebase. Coordinate AI-assisted engineering. Review changes. Verify outcomes.**

[![CI](https://github.com/ansh44233/FORGE-ECC/actions/workflows/ci.yml/badge.svg)](https://github.com/ansh44233/FORGE-ECC/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v1.0.0-64748b)](https://github.com/ansh44233/FORGE-ECC/releases/tag/v1.0.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933)](https://nodejs.org/)

[Website](https://forge-ecc.vercel.app/) · [Get the GitHub App](https://forge-ecc.vercel.app/api/github/install) · [Documentation](docs/) · [Source](https://github.com/ansh44233/FORGE-ECC) · [Issues](https://github.com/ansh44233/FORGE-ECC/issues) · [Releases](https://github.com/ansh44233/FORGE-ECC/releases)

</div>

<!--
DASHBOARD SCREENSHOT — add your real dashboard image here when ready.
Recommended path: docs/images/forge-dashboard.png
After uploading the image, replace this comment with:
<p align="center">
  <img src="docs/images/forge-dashboard.png" alt="FORGE local engineering dashboard" width="100%">
</p>
-->

> **Status:** FORGE v1.0 is a local-first engineering workbench. The CLI, local dashboard, MCP server and GitHub Action are available. The GitHub App installation foundation is available; hosted repository scanning and hosted pull-request automation are not yet implemented.

## What is FORGE?

FORGE (Engineering Workbench / Engineering Control Center) brings codebase intelligence and AI-assisted engineering workflows into one inspectable workspace.

It helps developers understand unfamiliar projects, map architecture and dependencies, inspect Git changes, review proposed patches, organize agent workflows and verify selected checks. FORGE is designed around evidence and explicit developer control: a suggestion is not an approved change, and validation, approval, staging and verification remain separate steps.

```text
discover → inspect → map → plan → implement → review → verify → learn
```

**The idea:** make engineering work easier to understand, easier to review and safer to verify — without hiding what the tools are doing.

## Quick links

| Resource | Description |
|---|---|
| [FORGE website](https://forge-ecc.vercel.app/) | Product overview and project links |
| [Get the GitHub App](https://forge-ecc.vercel.app/api/github/install) | Install FORGE on a GitHub account or organization |
| [Install the CLI](#install-for-windows) | Run FORGE locally on your machine |
| [Launch the dashboard](#launch-the-dashboard) | Open the local engineering control center |
| [GitHub Action](#github-action) | Run supported FORGE checks in CI |
| [Security policy](SECURITY.md) | Security boundaries and reporting |
| [Roadmap](docs/FORGE-CAPABILITY-ROADMAP.md) | Planned work and current boundaries |

## Product capabilities

FORGE is organized around a set of engineering capabilities that work together.

| Capability | What it does |
|---|---|
| Project intelligence | Detects project structure, languages, manifests, scripts, dependencies and source inventory |
| Code intelligence | Searches supported source files and extracts bounded code context |
| Architecture mapping | Builds import/dependency maps and highlights potential impact areas |
| Git intelligence | Inspects working-tree changes and revision comparisons |
| Quality and risk | Produces quality findings, project-health signals and engineering-risk summaries |
| Agent registry | Organizes specialist agents, skills, hooks and workspace context |
| Provider routing | Connects proposal-oriented work to supported local or API providers |
| Workflow orchestration | Records task plans, runs and workflow history |
| Human approval | Separates patch validation and approval from staging and promotion |
| Verification | Runs explicitly selected checks and stores verification history |
| Experiments and evaluations | Compares provider/model configurations using repeatable evaluation suites |
| Security audit | Performs bounded, read-only checks of supported agent configuration files |
| Local dashboard | Provides a browser-based control center for a selected local workspace |
| MCP server | Exposes bounded, read-only workspace inspection tools to compatible clients |
| GitHub Action | Runs repository inspection, quality, health and review operations in CI |
| GitHub App | Provides the installation and account-association foundation; hosted repository workflows are still in development |

Project-health and risk signals are prioritization aids. They are not security certifications and do not prove that a repository is defect-free.

## Install for Windows

### Requirements

- Windows 10 or newer
- Node.js 22 or newer
- npm (installed with Node.js)
- Git for Windows

Check the tools in PowerShell:

```powershell
node --version
npm --version
git --version
```

If Node.js is already installed, make sure its version is 22 or newer.

### Option A — Install the released CLI

Open **PowerShell** and run:

```powershell
npm install --global git+https://github.com/ansh44233/FORGE-ECC.git#v1.0.0
```

Confirm that the CLI is available:

```powershell
forge --version
forge --help
```

### Option B — Download the source and build it

Use this option if you want to inspect or modify FORGE itself:

```powershell
git clone https://github.com/ansh44233/FORGE-ECC.git
cd FORGE-ECC
npm ci
npm run typecheck
npm test
npm run build
```

The compiled CLI is available at `dist/cli.js`.

## Your first project

You can run FORGE against a project that already exists on your computer. First, open PowerShell in the folder where you keep your projects.

### 1. Move into your project folder

For example:

```powershell
cd C:\Users\YourName\Projects\my-project
```

Replace the example path with the real folder path of your project.

### 2. Initialize the workspace

```powershell
forge init .
```

This creates FORGE's local workspace state for the project.

### 3. Inspect the project

```powershell
forge inspect .
```

FORGE reports the project structure and available project signals.

### 4. Open the dashboard

```powershell
forge dashboard .
```

The command prints a local address. Open that address in your browser to view the dashboard for the selected workspace.

### Useful commands

```powershell
# Show available commands
forge --help

# Initialize a project
forge init .

# Inspect a project
forge inspect .

# Open the local dashboard
forge dashboard .

# Run the read-only agent configuration audit
forge agent-security .
forge agent-security . --json
```

Use `forge <command> --help` to see command-specific options.

## The FORGE dashboard

The full interactive dashboard is served locally by the FORGE CLI. It is separate from the public product website.

The dashboard brings together the information and workflow records available for the selected workspace:

- **Project overview:** source files, directories, dependencies and detected stack
- **Project health:** quality signals, snapshots and trends
- **Architecture:** dependency relationships and project structure
- **Agent registry:** specialist roles and agent information
- **Runs and tasks:** saved orchestration activity and run details
- **Approvals:** review and approval records for supported workflows
- **Workflow editor:** create and save reusable workflow definitions
- **Configuration studio:** manage workspace-owned agent and skill Markdown
- **Code search:** search supported source files and inspect matching context
- **Workspace explorer:** browse supported files and preview source
- **Code reviews:** inspect saved review snapshots and findings
- **Verification:** review selected check results and history
- **Traces and regression:** inspect execution traces and compare verification outcomes
- **Evaluations:** compare benchmark and experiment results

The dashboard displays data from the workspace you selected. Some panels depend on existing local records, configured providers or enabled permissions.

### Local-first privacy

The dashboard binds to the local machine and works against the workspace path supplied to the CLI. It is not hosted on the public FORGE website, and the local workspace is not automatically uploaded by opening the website or installing the GitHub App.

AI-assisted features may send selected context to the provider you configure. Review provider settings and data handling before using them with private code.

## GitHub App

<details>
<summary><strong>What does Get App do?</strong></summary>

The **Get App** link opens the FORGE GitHub App installation page. From GitHub, choose the personal account or organization where you want to install it, select the repositories covered by the installation, review the requested permissions and confirm.

[**Get the FORGE GitHub App →**](https://forge-ecc.vercel.app/api/github/install)

</details>

### Current GitHub App capabilities

The current release includes:

- GitHub App installation entry point
- Installation and installation-repository webhook handling
- Webhook signature verification
- Secure GitHub account authorization and session handling
- Server-side association of verified accounts and installation metadata

### Important current limitation

Installing the GitHub App does **not** currently start a hosted repository scan. The hosted App does not yet read repository contents, create pull requests or run autonomous repository workflows.

For project analysis today, clone or open the repository on your computer and use the local FORGE CLI and dashboard described above. GitHub App installation is a separate integration foundation.

See [GitHub App integration notes](docs/integrations/github-app.md) for setup details and the exact current boundaries.

## AI providers and editor integrations

FORGE separates **model/provider adapters** from **editor clients**. An editor that connects through MCP is not automatically a native editor extension.

| Tool or provider | Current integration |
|---|---|
| Claude Code CLI | Local authenticated CLI provider adapter; proposal-oriented run path |
| Claude Code MCP client | Can connect to the local FORGE stdio MCP server |
| Cursor | Can connect to the same local MCP server through Cursor MCP configuration |
| OpenAI-compatible API | Provider adapter; bounded native read-only tool loop is supported for OpenAI |
| Anthropic API | Provider adapter; normal run path is proposal-only |
| Google AI | Provider adapter; normal run path is proposal-only |
| Ollama | Local model endpoint adapter; normal run path is proposal-only |
| GitHub Actions | Reusable composite Action |
| Native Cursor/VS Code/OpenCode extension | Not shipped |
| Hosted autonomous coding agent | Not shipped |

### Claude Code

The local Claude Code provider adapter uses the authenticated Claude Code CLI. This is separate from configuring an Anthropic API key.

See [Claude Code integration notes](docs/integrations/claude-code.md).

### Cursor and MCP

Cursor can act as an MCP client for FORGE's local stdio MCP server. Configure the server in the Cursor project's `.cursor/mcp.json` (or supported user-level MCP configuration) and point it to the FORGE MCP launch command.

This is MCP interoperability, not a dedicated Cursor plugin. See [Cursor's MCP documentation](https://docs.cursor.com/context/mcp).

### Provider configuration

See [Provider configuration](docs/providers.md). Provider credentials are supplied by the developer in their own environment. Never commit API keys, access tokens or private keys.

## MCP server

Build FORGE, then launch the stdio MCP server with an explicit workspace.

Example for a Unix-like shell:

```bash
npm run build
FORGE_WORKSPACE=/absolute/path/to/project npm run mcp
```

The MCP server exposes bounded, read-only tools for:

- Project inspection and source inventory
- Architecture mapping
- Code search
- Quality auditing
- Git change intelligence
- Specialist/agent discovery
- Review-plan creation
- Workspace browsing

The workspace broker resolves paths beneath `FORGE_WORKSPACE`. Hidden paths, generated/dependency directories, secret-like filenames and symlinks are excluded or rejected. File reads and search results are bounded.

The MCP surface does not provide shell access, arbitrary network access, project-file writes, patch application or test execution. Some workspace browsing/search tools require an explicit restricted-mode allowlist in `.forge/permissions.json`; the default proposal-only policy denies them.

## GitHub Action

FORGE ships a composite GitHub Action for selected CI operations.

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

## Architecture

FORGE is a TypeScript Node.js application organized around a CLI entry point and focused core modules.

```text
Developer / CI
    |
    +-- forge CLI ---------------- src/cli.ts
    |      |
    |      +-- Project and code intelligence
    |      +-- Architecture / dependency analysis
    |      +-- Git / quality / risk analysis
    |      +-- Agent registry and orchestration
    |      +-- Review, approval and verification
    |      +-- Run, experiment and history stores
    |
    +-- Local dashboard ----------- src/core/dashboard-server.ts
    |      +-- Browser UI for a selected local workspace
    |
    +-- MCP server ---------------- src/mcp/server.ts
    |      +-- Bounded read-only workspace tools
    |
    +-- GitHub Action ------------- action.yml
           +-- CI: inspect / quality / health / review
```

### Main design boundaries

- **CLI:** initializes and inspects projects, starts the dashboard, runs checks and manages local workflow records.
- **Core modules:** implement analysis, orchestration, review, verification, policy enforcement and persistence.
- **Dashboard server:** serves the actual local dashboard and binds to loopback.
- **MCP server:** provides bounded workspace tools to external MCP clients. The current MCP surface is read-only.
- **GitHub Action:** packages selected CLI operations for CI.
- **Workspace state:** project-specific history, configuration and experiment records are stored under the workspace's `.forge/` directory.

## Technology stack

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

## Repository structure

```text
FORGE-ECC/
├── .forge/
│   └── evals/                    # Built-in evaluation suite data
├── .github/
│   └── workflows/                # CI, release and sandbox workflows
├── api/
│   ├── _lib/                     # GitHub App and OAuth helpers
│   └── github/                   # GitHub App API endpoints
├── docs/
│   ├── integrations/             # Provider and GitHub App guides
│   ├── providers.md              # Provider configuration
│   └── FORGE-CAPABILITY-ROADMAP.md
├── public/
│   ├── index.html                # Public product website
│   ├── forge-mark.svg            # Brand mark
│   └── forge-workbench.svg       # Brand artwork
├── src/
│   ├── ai/                       # AI provider adapters
│   ├── core/                     # Engineering workbench modules
│   ├── mcp/                      # MCP server and workspace path policy
│   └── cli.ts                    # CLI entry point
├── tests/                        # Unit and integration tests
├── action.yml                    # Reusable GitHub composite Action
├── package.json                  # Package metadata and scripts
├── vercel.json                   # Static website deployment config
├── CHANGELOG.md                  # Release history
├── CONTRIBUTING.md               # Contribution guide
├── LICENSE                       # MIT license
├── README.md                     # Project documentation
└── SECURITY.md                   # Security policy
```

### Core module map

The `src/core/` directory is split by responsibility. Key module groups include:

- **Project and code intelligence:** project inspection, project health, code intelligence/search, architecture maps, dependency graphs and impact analysis.
- **Git, review and quality:** Git intelligence, change intelligence, code review, AI review, review planning, quality audits and engineering risk.
- **Agents and orchestration:** agent registry, workspace context, skill registry, hook engine, orchestrator, model router and workflow store.
- **Permissions and patch lifecycle:** permission policy, patch validation, patch approval, patch application and workspace tool broker.
- **Verification and sandboxing:** verification, staged verification, container sandbox, sandbox policy/runtime/compliance/lifecycle.
- **History and evaluation:** run store/replay, execution traces, verification/review history, benchmark engine/matrix, evaluation engine and agent experiment studio.
- **Security:** agent security audit and the permission/workspace policy modules.

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

Read [SECURITY.md](SECURITY.md) before using FORGE with untrusted repositories, agent instructions or project scripts. The security audit is a static heuristic, not a security certification.

## Development

Clone the repository and install its dependencies:

```powershell
git clone https://github.com/ansh44233/FORGE-ECC.git
cd FORGE-ECC
npm ci
```

Run the quality checks:

```powershell
npm run typecheck
npm test
npm run build
```

Useful npm scripts:

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

The current release is the v1.0 foundation: local CLI, local dashboard, engineering analysis modules, MCP read-only tools, GitHub Action, public website and GitHub App installation/authentication foundation.

The GitHub App does **not** yet scan hosted repository contents, mint installation access tokens for repository workflows, create pull requests or run hosted autonomous agents. Native IDE extensions, hosted team workspaces and write-capable MCP tools are also not implied by the current integrations.

Future work is tracked in [docs/FORGE-CAPABILITY-ROADMAP.md](docs/FORGE-CAPABILITY-ROADMAP.md). A roadmap item should not be treated as shipped until the implementation, tests and documentation are available.

## Project links

- [FORGE website](https://forge-ecc.vercel.app/)
- [Get the GitHub App](https://forge-ecc.vercel.app/api/github/install)
- [FORGE-ECC source repository](https://github.com/ansh44233/FORGE-ECC)
- [FORGE WORKBENCH organization](https://github.com/forge-workbench)
- [Releases](https://github.com/ansh44233/FORGE-ECC/releases)
- [Issues](https://github.com/ansh44233/FORGE-ECC/issues)
- [CI workflows](https://github.com/ansh44233/FORGE-ECC/actions)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [License](LICENSE)

## Maintainer

**Ansh** — [@ansh44233](https://github.com/ansh44233)

## License

FORGE is released under the [MIT License](LICENSE).
