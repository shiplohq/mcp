# @shiplohq/mcp

MCP server for the Shiplo deploy platform. It lets AI clients (Claude Code, Claude Desktop, Codex CLI, Cursor, ...) deploy static sites, follow deployments, and manage sites on your Shiplo account through the Model Context Protocol.

## Tools

| Tool | What it does |
| --- | --- |
| `platform_account_status` | Get account status, plan, and usage information |
| `platform_list_sites` | List your sites |
| `platform_create_site` | Create a new site with a platform hostname |
| `platform_inspect_project` | Inspect a local project to detect build configuration |
| `platform_deploy_static` | Build and deploy a project directory as a static site |
| `platform_optimize_media` | Shrink an oversized image/video to fit a byte cap (images via sharp; video needs ffmpeg on PATH) |
| `platform_deployment_status` | Get the status of a deployment |
| `platform_deployment_events` | Get lifecycle events for a deployment |
| `platform_delete_site` | Delete a site |

## Install

```bash
npm install -g @shiplohq/mcp
```

Or run once with:

```bash
npx @shiplohq/mcp
```

Requires Node.js >= 24.

## Configuration

The server reads two environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `PLATFORM_API_TOKEN` | Yes | Shiplo API token (`shp_...`) — create one in the Shiplo dashboard |
| `PLATFORM_API_BASE_URL` | No | Defaults to `https://shiplo.site/v1` (the Shiplo cloud API). Override only when pointing at a self-hosted Shiplo instance |

### Claude Code

```bash
claude mcp add platform-mcp --env PLATFORM_API_TOKEN=shp_your_token -- npx -y @shiplohq/mcp
```

### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "platform-mcp": {
      "command": "npx",
      "args": ["-y", "@shiplohq/mcp"],
      "env": {
        "PLATFORM_API_TOKEN": "shp_your_token"
      }
    }
  }
}
```

### Codex CLI — `~/.codex/config.toml`

```toml
[mcp_servers.platform-mcp]
command = "npx"
args = ["-y", "@shiplohq/mcp"]
env = { PLATFORM_API_TOKEN = "shp_your_token" }
```

### Cursor — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

```json
{
  "mcpServers": {
    "platform-mcp": {
      "command": "npx",
      "args": ["-y", "@shiplohq/mcp"],
      "env": {
        "PLATFORM_API_TOKEN": "shp_your_token"
      }
    }
  }
}
```

### Any other MCP client

- Command: `npx -y @shiplohq/mcp`
- Transport: stdio
- Env: `PLATFORM_API_TOKEN` (required), `PLATFORM_API_BASE_URL` (optional)

## Media optimization notes

- Images are re-encoded in-process through `sharp` — no system dependencies needed.
- Video optimization requires an `ffmpeg` binary: resolved from `ffmpeg-static` (when installed alongside) or from `PATH`. When neither is available, the tool reports skip as the only option.

## License

MIT
