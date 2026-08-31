# @shiplohq/mcp-full

Full build of the [Shiplo MCP server](../README.md) — identical tools and
behavior, plus an ffmpeg binary bundled via `ffmpeg-static` so the
`platform_optimize_media` tool can optimize videos without a system ffmpeg
install. Images work out of the box in both builds (bundled sharp).

## Install

```bash
npm install -g @shiplohq/mcp-full@latest
```

Or run once with:

```bash
npx -y @shiplohq/mcp-full@latest
```

## Configuration

Same as the light build: `PLATFORM_API_TOKEN` (required) and
`PLATFORM_API_BASE_URL` (optional). Client setup examples are in the
[root README](../README.md) — use `@shiplohq/mcp-full` in place of
`@shiplohq/mcp`. For example, with Claude Code:

```bash
claude mcp add platform-mcp-full --env PLATFORM_API_TOKEN=shp_your_token -- npx -y @shiplohq/mcp-full@latest
```

## License

MIT
