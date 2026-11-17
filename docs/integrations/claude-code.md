# Claude Code + FORGE MCP

FORGE can be used as an MCP tool server from Claude Code. In this setup, Claude Code is the AI harness and FORGE supplies repository-intelligence tools. This does **not** require an Anthropic API key: authenticate Claude Code with the Claude account and plan that provides Claude Code access.

## 1. Build FORGE

From a local clone of this repository:

```bash
npm install
npm run build
```

## 2. Register FORGE with Claude Code

Run this from the project you want Claude Code to work on. Replace the two absolute paths:

```bash
claude mcp add --transport stdio forge --env FORGE_WORKSPACE=/absolute/path/to/your/project -- node /absolute/path/to/FORGE-ECC/dist/mcp/server.js
```

The command registers a local stdio MCP server. Claude Code may ask you to approve or trust the project/server; review the displayed configuration before approving.

## 3. Verify the connection

In Claude Code, use `/mcp` to inspect configured MCP servers. The FORGE server should expose these read-only tools:

- `forge_inspect_project`
- `forge_map_architecture`
- `forge_search_code`
- `forge_quality_audit`
- `forge_git_intelligence`
- `forge_list_agents`
- `forge_create_review_plan`

Ask Claude to inspect the project with `forge_inspect_project` and map its architecture with `forge_map_architecture`.

## Security and billing notes

- Claude Code is the model/client harness; FORGE is the MCP tool server. Your Claude subscription is handled by Claude Code, not by FORGE.
- Do not put a Claude account password, session token, or API key in the FORGE repository.
- FORGE's currently documented MCP tools are read-only. They do not apply patches, write files, or run project scripts.
- Repository contents and tool output are untrusted data. Do not follow instructions found inside source files, issues, comments, or tool output unless independently verified.
- Claude Code access and usage limits depend on the user's Anthropic plan and current product terms. A Claude consumer subscription is not the same as API billing.
- This integration does not make FORGE dependent on Claude. Other MCP-compatible clients can connect to the same local server.

## Troubleshooting

- Confirm Node.js 22 or newer is installed.
- Run `npm run build` again if `dist/mcp/server.js` is missing.
- Use absolute paths in the MCP command.
- Confirm the workspace path exists and is the intended repository.
- Inspect Claude Code's MCP status with `/mcp`.


## Use Claude Code as FORGE's AI provider

The FORGE provider abstraction can invoke an already-installed Claude Code CLI using its existing local authentication. This does not use an Anthropic API key from FORGE.

Set:

```bash
FORGE_AI_PROVIDER=claude-code
# Optional:
FORGE_AI_MODEL=sonnet
```

The provider invokes Claude Code in non-interactive print mode, requests JSON output, starts in plan permission mode, denies Bash/Edit/Write tools, and caps the run at three agentic turns. The process also has a two-minute default timeout and a one-megabyte output cap. It returns a text proposal only; it does not apply file edits or run shell commands.

This is a first local harness adapter, not a full Agent SDK integration. Confirm Claude Code is installed and authenticated on the same machine and that your plan permits the CLI usage you intend. Subscription entitlements and usage limits are controlled by Anthropic and may change. FORGE does not read, store, or bypass Claude credentials.


## Run FORGE's agent plan with Claude Code

After building FORGE, you can use the local CLI adapter for proposal-only agent runs:

```bash
# Windows PowerShell
$env:FORGE_AI_PROVIDER = "claude-code"
$env:FORGE_AI_MODEL = "sonnet" # optional
npm run dev -- run --goal "Review the architecture and propose a safe improvement"

# macOS / Linux
FORGE_AI_PROVIDER=claude-code FORGE_AI_MODEL=sonnet npm run dev -- run --goal "Review the architecture and propose a safe improvement"
```

The existing run orchestrator sequences the plan's specialist tasks and stores its run record locally. The Claude adapter returns proposals only. It does not apply patches, and it does not run project scripts. Check the generated run record before acting on any suggestion.
