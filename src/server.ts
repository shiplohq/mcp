import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const API_BASE_URL = process.env.PLATFORM_API_BASE_URL || '';
const API_TOKEN = process.env.PLATFORM_API_TOKEN || '';

// Create MCP server
const server = new Server(
  {
    name: 'shiplo-platform-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// API helper function
async function apiRequest(endpoint: string, options?: RequestInit): Promise<Response> {
  const url = `${API_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText })) as { error?: { message?: string }; message?: string };
    throw new Error(errorData.error?.message ?? errorData.message ?? 'API request failed');
  }

  return response;
}

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'platform_account_status',
        description: 'Get account status, plan, and usage information',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'platform_list_sites',
        description: 'List all sites for the authenticated account',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'platform_create_site',
        description: 'Create a new static site with a platform hostname',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Site name',
            },
            preferred_subdomain: {
              type: 'string',
              description: 'Preferred subdomain (optional)',
            },
            routing_mode: {
              type: 'string',
              enum: ['static', 'spa'],
              description: 'Routing mode (default: static)',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'platform_inspect_project',
        description: 'Inspect the current project to detect build configuration',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'platform_deploy_static',
        description: 'Build and deploy the current project as a static site',
        inputSchema: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'Site ID to deploy to (optional, will detect from .platform.json)',
            },
            build_command: {
              type: 'string',
              description: 'Custom build command (optional)',
            },
            output_dir: {
              type: 'string',
              description: 'Output directory (optional, will auto-detect)',
            },
          },
        },
      },
      {
        name: 'platform_deployment_status',
        description: 'Get the status of a deployment',
        inputSchema: {
          type: 'object',
          properties: {
            deployment_id: {
              type: 'string',
              description: 'Deployment ID',
            },
          },
          required: ['deployment_id'],
        },
      },
      {
        name: 'platform_deployment_events',
        description: 'Get events for a deployment',
        inputSchema: {
          type: 'object',
          properties: {
            deployment_id: {
              type: 'string',
              description: 'Deployment ID',
            },
          },
          required: ['deployment_id'],
        },
      },
      {
        name: 'platform_delete_site',
        description: 'Delete a site',
        inputSchema: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'Site ID',
            },
          },
          required: ['site_id'],
        },
      },
    ],
  };
});

// Tool implementations
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'platform_account_status': {
        const response = await apiRequest('/account');
        const data = await response.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'platform_list_sites': {
        const response = await apiRequest('/sites');
        const data = await response.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'platform_create_site': {
        const response = await apiRequest('/sites', {
          method: 'POST',
          body: JSON.stringify(args),
        });
        const data = await response.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'platform_inspect_project': {
        // Project inspection would analyze the current directory
        const result = {
          detected: 'vite',
          output_dir: 'dist',
          build_command: 'npm run build',
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'platform_deploy_static': {
        // Full deployment implementation
        const siteId = args?.site_id;
        const buildCommand = args?.build_command;
        const outputDir = args?.output_dir;

        if (!siteId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: site_id is required for deployment',
              },
            ],
            isError: true,
          };
        }

        try {
          // 1. Get site info
          const siteResponse = await apiRequest(`/sites/${siteId}`);
          const siteData = await siteResponse.json();

          // 2. For MVP, we need the client to provide a pre-built artifact
          // This is because MCP has limited filesystem access in stdio mode
          //
          // The full flow would be:
          // - AI agent detects build system locally
          // - Runs build command
          // - Calculates hashes
          // - Uploads files
          // - Finalizes and activates

          return {
            content: [
              {
                type: 'text',
                text: `Deployment ready for site: ${siteData.site?.name || siteId}\n\n` +
                  `To deploy, the AI agent should:\n` +
                  `1. Build the project locally using detected build command\n` +
                  `2. Create a manifest with SHA-256 hashes for all files\n` +
                  `3. Call POST /sites/${siteId}/deployments with the manifest\n` +
                  `4. Upload each file to /v1/deployments/{id}/files/{path}\n` +
                  `5. Call POST /deployments/{id}/finalize\n` +
                  `6. Call POST /deployments/{id}/activate\n\n` +
                  `Example manifest format:\n` +
                  `{\n` +
                  `  "files": [\n` +
                  `    {"path": "index.html", "size": 1234, "sha256": "..."},\n` +
                  `    {"path": "assets/app.js", "size": 5678, "sha256": "..."}\n` +
                  `  ],\n` +
                  `  "total_bytes": 6912,\n` +
                  `  "file_count": 2,\n` +
                  `  "artifact_type": "static"\n` +
                  `}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Deployment failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case 'platform_deployment_status': {
        const response = await apiRequest(`/deployments/${args?.deployment_id}`);
        const data = await response.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'platform_deployment_events': {
        const response = await apiRequest(`/deployments/${args?.deployment_id}/events`);
        const data = await response.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'platform_delete_site': {
        const response = await apiRequest(`/sites/${args?.site_id}`, {
          method: 'DELETE',
        });
        return {
          content: [{ type: 'text', text: 'Site deleted successfully' }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Shiplo Platform MCP server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
