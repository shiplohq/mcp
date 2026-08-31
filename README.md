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

`platform_deploy_static` runs the optional `build_command`, scans `output_dir`
(or auto-detects `dist`, `out`, `build`, or a project-root `index.html`), creates
a SHA-256 manifest, uploads every file, finalizes the release, and activates it.
It then polls the public URL until the edge stops serving the unprovisioned-host
placeholder (`live: true`, up to ~75 seconds) and only then returns JSON with
`deployment_id`, `release_id`, `status`, `url`, and `live`. If the wait times
out, `live` is `false` with a `live_note` — the deploy itself is already active,
and the URL typically works a few seconds later. Set `PLATFORM_LIVE_WAIT_TIMEOUT_MS=0`
to skip the wait. Project-root deployments exclude `.env*`, `.npmrc`, `.git`, and
`node_modules`, plus common credential files such as `.mcp.json`, private keys,
and cloud CLI credential directories, so local secrets are not uploaded. The
Shiplo API token is removed from the environment of any requested build command.

On the first deployment, Shiplo detects the project settings and writes a
committed `.shiplo/project.json` containing the project name, Shiplo site ID,
subdomain, build command, and output directory. It never stores the API token.
Later deployments reuse this file, so a normal "deploy this project" request
does not need the same setup questions again. Existing projects without the file
remain compatible: their next deployment creates it automatically.

## Install

```bash
npm install -g @shiplohq/mcp@latest
```

Or run once with:

```bash
npx @shiplohq/mcp@latest
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
claude mcp add platform-mcp --env PLATFORM_API_TOKEN=shp_your_token -- npx -y @shiplohq/mcp@latest
```

### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "platform-mcp": {
      "command": "npx",
      "args": ["-y", "@shiplohq/mcp@latest"],
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
args = ["-y", "@shiplohq/mcp@latest"]
env = { PLATFORM_API_TOKEN = "shp_your_token" }
```

### Cursor — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

```json
{
  "mcpServers": {
    "platform-mcp": {
      "command": "npx",
      "args": ["-y", "@shiplohq/mcp@latest"],
      "env": {
        "PLATFORM_API_TOKEN": "shp_your_token"
      }
    }
  }
}
```

### Any other MCP client

- Command: `npx -y @shiplohq/mcp@latest`
- Transport: stdio
- Env: `PLATFORM_API_TOKEN` (required), `PLATFORM_API_BASE_URL` (optional)

### Upgrading an existing setup

Change a pinned or unqualified package entry to `@shiplohq/mcp@latest`, then
restart the MCP server or IDE once. You do not need to change website source,
delete an existing Shiplo site, or create `.shiplo` manually. The next deployment
backfills `.shiplo/project.json` and keeps using the existing site ID supplied by
older clients.

## Media optimization notes

- Images are re-encoded in-process through `sharp` — no system dependencies needed.
- Video optimization requires an `ffmpeg` binary: resolved from `ffmpeg-static` (when installed alongside) or from `PATH`. When neither is available, the tool reports skip as the only option.
- No system ffmpeg? Install the full build [`@shiplohq/mcp-full`](full/README.md) — same server with an ffmpeg binary bundled via `ffmpeg-static`:

  ```bash
  claude mcp add platform-mcp-full --env PLATFORM_API_TOKEN=shp_your_token -- npx -y @shiplohq/mcp-full@latest
  ```

## License

MIT
