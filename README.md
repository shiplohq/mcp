# @shiplohq/mcp

MCP server for the Shiplo deploy platform. It lets AI clients (Claude Code, Claude Desktop, Codex CLI, Cursor, ...) deploy static sites and manage sites on your Shiplo account through the Model Context Protocol.

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
| `platform_delete_site` | Delete a site |

`platform_deploy_static` runs the optional `build_command`, scans `output_dir`
(or auto-detects `dist`, `out`, `build`, or a project-root `index.html`), creates
a SHA-256 manifest, uploads every file, finalizes the release, and activates it.
Uploads run concurrently with bounded retry and can resume an interrupted
deployment with `resume_deployment_id`; server-side hashes and an idempotent
upload ledger prevent retries from double-counting bytes. Pass either `site_id`
or the more convenient `site_slug`. Oversized files require an explicit
`oversized` policy: `optimize`, `skip`, or `error`. Deploy-time optimization
uses an isolated temporary artifact and never rewrites the project source.
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
version-controllable `.shiplo/project.json` containing the project name, Shiplo site ID,
subdomain, build command, and output directory. It never stores the API token.
Later deployments reuse this file, so a normal "deploy this project" request
does not need the same setup questions again. Existing projects without the file
remain compatible: their next deployment creates it automatically. If a first
upload fails after Shiplo creates the site, the config is still saved so a retry
reuses that site instead of creating an orphan duplicate.

Tool responses expose native MCP `structuredContent` for clients that support
it while retaining the JSON text response for older clients. Progress-aware
clients receive build, scan, optimize, upload, finalize, activate, and live-wait
updates, and cancellation stops retries and URL polling promptly.

## Install

```bash
npm install -g @shiplohq/mcp@0.1.6
```

Or run once with:

```bash
npx @shiplohq/mcp@0.1.6
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
claude mcp add platform-mcp --env PLATFORM_API_TOKEN=shp_your_token -- npx -y @shiplohq/mcp@0.1.6
```

### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "platform-mcp": {
      "command": "npx",
      "args": ["-y", "@shiplohq/mcp@0.1.6"],
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
args = ["-y", "@shiplohq/mcp@0.1.6"]
env = { PLATFORM_API_TOKEN = "shp_your_token" }
```

### Cursor — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

```json
{
  "mcpServers": {
    "platform-mcp": {
      "command": "npx",
      "args": ["-y", "@shiplohq/mcp@0.1.6"],
      "env": {
        "PLATFORM_API_TOKEN": "shp_your_token"
      }
    }
  }
}
```

### Any other MCP client

- Command: `npx -y @shiplohq/mcp@0.1.6`
- Transport: stdio
- Env: `PLATFORM_API_TOKEN` (required), `PLATFORM_API_BASE_URL` (optional)

### Upgrading an existing setup

Pin an exact package version so the deploy implementation stays reproducible
across sessions. To upgrade, deliberately change the pin after reviewing the
new release, then restart the MCP server or IDE once.

### Windows-native MCP clients

Some Windows clients use hardened process spawning and cannot resolve the
`npx.cmd` shim directly. Use `cmd /c`:

```json
{
  "mcpServers": {
    "platform-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@shiplohq/mcp@0.1.6"],
      "env": { "PLATFORM_API_TOKEN": "shp_your_token" }
    }
  }
}
```

For Codex on Windows, use the equivalent TOML:

```toml
[mcp_servers.platform-mcp]
command = "cmd"
args = ["/c", "npx", "-y", "@shiplohq/mcp@0.1.6"]
env = { PLATFORM_API_TOKEN = "shp_your_token" }
```

## Media optimization notes

- Images are re-encoded in-process through `sharp` — no system dependencies needed.
- Video optimization requires an `ffmpeg` binary: resolved from `ffmpeg-static` (when installed alongside) or from `PATH`. When neither is available, the tool reports skip as the only option.
- Until the optional full package is published, install ffmpeg on `PATH` when
  video optimization is needed. The standard package still optimizes images.

## License

MIT
