#!/usr/bin/env node
// Full Shiplo MCP entry point: same server as the light build, but the
// ffmpeg-static dependency installed alongside makes video optimization
// available (the server detects it at runtime).
require('@shiplohq/mcp/dist/cli.js');
