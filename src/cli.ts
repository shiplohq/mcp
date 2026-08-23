#!/usr/bin/env node
// MCP CLI entry point - just import the server module which handles everything
import('./server.js').catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
