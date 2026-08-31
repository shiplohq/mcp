import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { statSync } from 'fs';
import { isMediaFile } from '@shiplohq/contracts';
import { optimizeImage, optimizeVideo, VIDEO_EXTENSIONS } from './optimize.js';
import { deployStatic, serializeDeployError } from './deploy.js';
import {
  inspectProject,
  projectConfigPath,
  readProjectConfig,
  writeProjectConfig,
} from './project-config.js';

const API_BASE_URL = process.env.PLATFORM_API_BASE_URL || 'https://shiplo.site/v1';
const API_TOKEN = process.env.PLATFORM_API_TOKEN || '';

class ShiploRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
    public readonly details: unknown
  ) {
    super(message);
    this.name = 'ShiploRequestError';
  }
}

// Create MCP server
const server = new Server(
  {
    name: 'shiplo-platform-mcp',
    version: '0.1.3',
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
    const errorData = await response.json().catch(() => ({ message: response.statusText })) as {
      error?: { code?: string; message?: string; details?: unknown };
      message?: string;
    };
    throw new ShiploRequestError(
      response.status,
      errorData.error?.code,
      errorData.error?.message ?? errorData.message ?? 'API request failed',
      errorData.error?.details
    );
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
        description:
          'Deploy the current project as a static site. On first use, detects settings and writes .shiplo/project.json; later calls reuse it. ' +
          'Runs build_command first when configured. Honors plan upload limits ' +
          '(per-file size cap and account-wide file cap — call platform_account_status first ' +
          'to get them); oversized images/videos trigger an interactive optimize-or-skip choice ' +
          'for the user.',
        inputSchema: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'Site ID override (optional; uses .shiplo config or creates a site on first deploy)',
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
        name: 'platform_optimize_media',
        description:
          'Shrink an oversized local image or video file to fit a byte cap, in place ' +
          '(images re-encode via sharp; videos via ffmpeg — available in the full MCP ' +
          'build or when ffmpeg is on PATH). Call this after the user chose "optimize" ' +
          'over "skip" for a file exceeding plan.max_file_size_bytes.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path of the media file to optimize',
            },
            max_bytes: {
              type: 'integer',
              description: 'Target size cap in bytes (use plan.max_file_size_bytes)',
              minimum: 1,
            },
          },
          required: ['path', 'max_bytes'],
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
        const inspection = await inspectProject(process.cwd());
        const config = await readProjectConfig(process.cwd());
        const result = {
          configured: config !== null,
          config_path: projectConfigPath(process.cwd()),
          ...inspection,
          site_id: config?.site_id ?? null,
          subdomain: config?.subdomain ?? null,
          ...(config ? {
            project_name: config.project_name,
            build_command: config.build_command,
            output_dir: config.output_dir,
          } : {}),
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

        try {
          let resolvedSiteId = typeof siteId === 'string' ? siteId : undefined;
          let resolvedBuildCommand = typeof buildCommand === 'string' ? buildCommand : undefined;
          let resolvedOutputDir = typeof outputDir === 'string' ? outputDir : undefined;
          const savedConfig = await readProjectConfig(process.cwd());

          resolvedSiteId = resolvedSiteId ?? savedConfig?.site_id;
          resolvedBuildCommand = resolvedBuildCommand ?? savedConfig?.build_command ?? undefined;
          resolvedOutputDir = resolvedOutputDir ?? savedConfig?.output_dir;

          if (!resolvedSiteId) {
            const inspection = await inspectProject(process.cwd());
            resolvedBuildCommand = resolvedBuildCommand ?? inspection.build_command ?? undefined;
            resolvedOutputDir = resolvedOutputDir ?? inspection.output_dir ?? undefined;
            if (!resolvedOutputDir) {
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    error: {
                      code: 'PROJECT_CONFIG_REQUIRED',
                      message: 'Shiplo could not safely detect all deployment settings',
                      config_path: projectConfigPath(process.cwd()),
                      missing_fields: ['output_dir'],
                    },
                  }, null, 2),
                }],
                isError: true,
              };
            }
            const createSite = (preferredSubdomain?: string) => apiRequest('/sites', {
              method: 'POST',
              body: JSON.stringify({
                name: inspection.project_name,
                ...(preferredSubdomain ? { preferred_subdomain: preferredSubdomain } : {}),
                routing_mode: 'static',
              }),
            });
            let response: Response;
            try {
              response = await createSite(inspection.preferred_subdomain);
            } catch (error) {
              if (
                error instanceof ShiploRequestError
                && error.status === 409
                && error.code === 'HOSTNAME_NOT_AVAILABLE'
              ) {
                response = await createSite();
              } else {
                throw error;
              }
            }
            const created = await response.json() as {
              site?: { id?: string; slug?: string };
              hostnames?: Array<{ hostname?: string; is_primary?: boolean }>;
            };
            if (!created.site?.id) throw new Error('Shiplo API did not return site.id');
            const hostname = created.hostnames?.find((item) => item.is_primary)?.hostname
              ?? created.hostnames?.[0]?.hostname;
            resolvedSiteId = created.site.id;
            await writeProjectConfig(process.cwd(), {
              version: 1,
              project_name: inspection.project_name,
              site_id: resolvedSiteId,
              subdomain: created.site.slug ?? hostname?.split('.')[0] ?? inspection.preferred_subdomain,
              build_command: resolvedBuildCommand ?? null,
              output_dir: resolvedOutputDir,
            });
          } else if (!savedConfig) {
            const inspection = await inspectProject(process.cwd());
            const siteResponse = await apiRequest(`/sites/${encodeURIComponent(resolvedSiteId)}`);
            const siteData = await siteResponse.json() as {
              site?: { id?: string; name?: string; slug?: string; hostname?: string | null };
              hostnames?: Array<{ hostname?: string; is_primary?: boolean }>;
            };
            const hostname = siteData.site?.hostname
              ?? siteData.hostnames?.find((item) => item.is_primary)?.hostname
              ?? siteData.hostnames?.[0]?.hostname;
            resolvedBuildCommand = resolvedBuildCommand ?? inspection.build_command ?? undefined;
            resolvedOutputDir = resolvedOutputDir ?? inspection.output_dir ?? undefined;
            if (!resolvedOutputDir) {
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    error: {
                      code: 'PROJECT_CONFIG_REQUIRED',
                      message: 'Shiplo could not safely detect all deployment settings',
                      config_path: projectConfigPath(process.cwd()),
                      missing_fields: ['output_dir'],
                    },
                  }, null, 2),
                }],
                isError: true,
              };
            }
            await writeProjectConfig(process.cwd(), {
              version: 1,
              project_name: inspection.project_name,
              site_id: resolvedSiteId,
              subdomain: siteData.site?.slug ?? hostname?.split('.')[0] ?? inspection.preferred_subdomain,
              build_command: resolvedBuildCommand ?? null,
              output_dir: resolvedOutputDir,
            });
          } else if (
            (typeof buildCommand === 'string' && buildCommand !== savedConfig.build_command)
            || (typeof outputDir === 'string' && outputDir !== savedConfig.output_dir)
            || (typeof siteId === 'string' && siteId !== savedConfig.site_id)
          ) {
            await writeProjectConfig(process.cwd(), {
              ...savedConfig,
              site_id: resolvedSiteId,
              build_command: resolvedBuildCommand ?? null,
              output_dir: resolvedOutputDir ?? savedConfig.output_dir,
            });
          }

          const result = await deployStatic({
            siteId: resolvedSiteId,
            buildCommand: resolvedBuildCommand,
            outputDir: resolvedOutputDir,
            apiBaseUrl: API_BASE_URL,
            apiToken: API_TOKEN,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify(serializeDeployError(error), null, 2) }],
            isError: true,
          };
        }
      }

      case 'platform_optimize_media': {
        const filePath = args?.path;
        const maxBytes = args?.max_bytes;

        if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
          return {
            content: [{ type: 'text', text: 'Error: path must be an absolute file path' }],
            isError: true,
          };
        }
        if (typeof maxBytes !== 'number' || maxBytes < 1) {
          return {
            content: [{ type: 'text', text: 'Error: max_bytes must be a positive integer' }],
            isError: true,
          };
        }
        let size: number;
        try {
          size = statSync(filePath).size;
        } catch {
          return {
            content: [{ type: 'text', text: `Error: file not found: ${filePath}` }],
            isError: true,
          };
        }
        if (!isMediaFile(filePath)) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: not a media file (checked extension). Offer the user skip: ${filePath}`,
              },
            ],
            isError: true,
          };
        }

        const result = VIDEO_EXTENSIONS.some((ext) =>
          filePath.toLowerCase().endsWith(ext)
        )
          ? await optimizeVideo(filePath, maxBytes)
          : await optimizeImage(filePath, maxBytes);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
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
