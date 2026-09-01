import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { statSync } from 'fs';
import { isMediaFile } from '@shiplohq/contracts';
import { isAbsoluteMediaPath, optimizeImage, optimizeVideo, VIDEO_EXTENSIONS } from './optimize.js';
import {
  deployStatic, disposePreparedStaticDeployment, prepareStaticDeployment, serializeDeployError,
} from './deploy.js';
import {
  inspectProject,
  projectConfigPath,
  readProjectConfig,
  type ShiploProjectConfig,
  writeProjectConfig,
} from './project-config.js';

const API_BASE_URL = process.env.PLATFORM_API_BASE_URL || 'https://shiplo.site/v1';
const API_TOKEN = process.env.PLATFORM_API_TOKEN || '';
const OBJECT_OUTPUT_SCHEMA = { type: 'object' as const, additionalProperties: true };

function toolResult(data: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

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
    version: '0.1.6',
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

async function resolveSiteReference(reference: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference)) {
    return reference;
  }
  const response = await apiRequest('/sites');
  const data = await response.json() as {
    sites?: Array<{ id?: string; slug?: string; hostname?: string | null }>;
  };
  const normalized = reference.toLowerCase();
  const matches = (data.sites ?? []).filter((site) =>
    site.slug?.toLowerCase() === normalized
    || site.hostname?.toLowerCase() === normalized
    || site.hostname?.toLowerCase() === `${normalized}.shiplo.site`
  );
  if (matches.length !== 1 || !matches[0].id) {
    throw new Error(matches.length > 1
      ? `Site reference is ambiguous: ${reference}`
      : `Site not found by ID, slug, or hostname: ${reference}`);
  }
  return matches[0].id;
}

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'platform_account_status',
        description: 'Get account status, plan, and usage information',
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'platform_list_sites',
        description: 'List all sites for the authenticated account',
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'platform_create_site',
        description: 'Create a new static site with a platform hostname',
        outputSchema: OBJECT_OUTPUT_SCHEMA,
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
          },
          required: ['name'],
        },
      },
      {
        name: 'platform_inspect_project',
        description: 'Inspect the current project to detect build configuration',
        outputSchema: OBJECT_OUTPUT_SCHEMA,
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
          'to get them); set oversized explicitly to optimize or skip files over the plan cap. ' +
          'The tool polls the URL after activation and only returns once the edge ' +
          'serves the site (`live: true`, up to ~75s); if it times out, `live` is false and the ' +
          'user should retry the URL in a minute — the deploy itself is already active.',
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        inputSchema: {
          type: 'object',
          properties: {
            site_id: {
              type: 'string',
              description: 'Site UUID override (optional; uses .shiplo config or creates a site on first deploy)',
            },
            site_slug: {
              type: 'string',
              description: 'Site slug or hostname override; avoids a separate list-sites call',
            },
            build_command: {
              type: 'string',
              description: 'Custom build command (optional)',
            },
            output_dir: {
              type: 'string',
              description: 'Output directory (optional, will auto-detect)',
            },
            resume_deployment_id: {
              type: 'string',
              description: 'Resume an interrupted created/uploading deployment',
            },
            oversized: {
              type: 'string',
              enum: ['optimize', 'skip', 'error'],
              description: 'Policy for files over the plan cap (default: error)',
            },
          },
        },
      },
      {
        name: 'platform_optimize_media',
        description:
          'Shrink an oversized local image or video file to fit a byte cap, in place ' +
          '(images re-encode via sharp; videos require ffmpeg on PATH). ' +
          'This tool always performs the requested optimization.',
        outputSchema: OBJECT_OUTPUT_SCHEMA,
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
        outputSchema: OBJECT_OUTPUT_SCHEMA,
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
        outputSchema: OBJECT_OUTPUT_SCHEMA,
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
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'platform_account_status': {
        const response = await apiRequest('/account');
        const data = await response.json();
        return toolResult(data as Record<string, unknown>);
      }

      case 'platform_list_sites': {
        const response = await apiRequest('/sites');
        const data = await response.json();
        return toolResult(data as Record<string, unknown>);
      }

      case 'platform_create_site': {
        const response = await apiRequest('/sites', {
          method: 'POST',
          body: JSON.stringify({
            name: args?.name,
            ...(typeof args?.preferred_subdomain === 'string'
              ? { preferred_subdomain: args.preferred_subdomain }
              : {}),
          }),
        });
        const data = await response.json();
        return toolResult(data as Record<string, unknown>);
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
        return toolResult(result);
      }

      case 'platform_deploy_static': {
        // Full deployment implementation
        const siteId = args?.site_id;
        const siteSlug = args?.site_slug;
        const buildCommand = args?.build_command;
        const outputDir = args?.output_dir;
        const resumeDeploymentId = args?.resume_deployment_id;
        const oversized = args?.oversized;
        let createdSiteConfig: ShiploProjectConfig | undefined;
        let prepared: Awaited<ReturnType<typeof prepareStaticDeployment>> | undefined;

        try {
          let resolvedSiteId = typeof siteId === 'string'
            ? siteId
            : typeof siteSlug === 'string'
              ? await resolveSiteReference(siteSlug)
              : undefined;
          let resolvedBuildCommand = typeof buildCommand === 'string' ? buildCommand : undefined;
          let resolvedOutputDir = typeof outputDir === 'string' ? outputDir : undefined;
          const savedConfig = await readProjectConfig(process.cwd());
          let nextConfig: ShiploProjectConfig | undefined;

          const progressToken = request.params._meta?.progressToken;
          const onProgress = progressToken === undefined ? undefined : async (update: {
            completed: number; total: number; message: string;
          }) => {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: update.completed,
                total: update.total,
                message: update.message,
              },
            });
          };

          resolvedSiteId = resolvedSiteId ?? savedConfig?.site_id;
          resolvedBuildCommand = resolvedBuildCommand ?? savedConfig?.build_command ?? undefined;
          resolvedOutputDir = resolvedOutputDir ?? savedConfig?.output_dir;

          if (!resolvedSiteId) {
            const inspection = await inspectProject(process.cwd());
            resolvedBuildCommand = resolvedBuildCommand ?? inspection.build_command ?? undefined;
            resolvedOutputDir = resolvedOutputDir ?? inspection.output_dir ?? undefined;
            if (!resolvedOutputDir) {
              return toolResult({ error: {
                code: 'PROJECT_CONFIG_REQUIRED',
                message: 'Shiplo could not safely detect all deployment settings',
                config_path: projectConfigPath(process.cwd()),
                missing_fields: ['output_dir'],
              } }, true);
            }
            prepared = await prepareStaticDeployment({
              cwd: process.cwd(), buildCommand: resolvedBuildCommand, outputDir: resolvedOutputDir,
              apiBaseUrl: API_BASE_URL, apiToken: API_TOKEN,
              oversized: oversized === 'optimize' || oversized === 'skip' || oversized === 'error' ? oversized : undefined,
              signal: extra.signal, onProgress,
            });
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
            nextConfig = {
              version: 1,
              project_name: inspection.project_name,
              site_id: resolvedSiteId,
              subdomain: created.site.slug ?? hostname?.split('.')[0] ?? inspection.preferred_subdomain,
              build_command: resolvedBuildCommand ?? null,
              output_dir: resolvedOutputDir,
            };
            createdSiteConfig = nextConfig;
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
              return toolResult({ error: {
                code: 'PROJECT_CONFIG_REQUIRED',
                message: 'Shiplo could not safely detect all deployment settings',
                config_path: projectConfigPath(process.cwd()),
                missing_fields: ['output_dir'],
              } }, true);
            }
            nextConfig = {
              version: 1,
              project_name: inspection.project_name,
              site_id: resolvedSiteId,
              subdomain: siteData.site?.slug ?? hostname?.split('.')[0] ?? inspection.preferred_subdomain,
              build_command: resolvedBuildCommand ?? null,
              output_dir: resolvedOutputDir,
            };
          } else if (
            (typeof buildCommand === 'string' && buildCommand !== savedConfig.build_command)
            || (typeof outputDir === 'string' && outputDir !== savedConfig.output_dir)
            || (typeof siteId === 'string' && siteId !== savedConfig.site_id)
            || typeof siteSlug === 'string'
          ) {
            nextConfig = {
              ...savedConfig,
              site_id: resolvedSiteId,
              build_command: resolvedBuildCommand ?? null,
              output_dir: resolvedOutputDir ?? savedConfig.output_dir,
            };
          }

          const result = await deployStatic({
            siteId: resolvedSiteId,
            buildCommand: resolvedBuildCommand,
            outputDir: resolvedOutputDir,
            apiBaseUrl: API_BASE_URL,
            apiToken: API_TOKEN,
            resumeDeploymentId: typeof resumeDeploymentId === 'string' ? resumeDeploymentId : undefined,
            oversized: oversized === 'optimize' || oversized === 'skip' || oversized === 'error' ? oversized : undefined,
            prepared,
            signal: extra.signal,
            onProgress,
          });
          if (nextConfig) await writeProjectConfig(process.cwd(), nextConfig);
          return toolResult(result as unknown as Record<string, unknown>);
        } catch (error) {
          await disposePreparedStaticDeployment(prepared);
          if (createdSiteConfig) {
            try {
              await writeProjectConfig(process.cwd(), createdSiteConfig);
            } catch {
              // Preserve the deployment error. The serialized deployment id still
              // lets the caller resume even if local config persistence also fails.
            }
          }
          return toolResult(serializeDeployError(error), true);
        }
      }

      case 'platform_optimize_media': {
        const filePath = args?.path;
        const maxBytes = args?.max_bytes;

        if (typeof filePath !== 'string' || !isAbsoluteMediaPath(filePath)) {
          return toolResult({ error: { message: 'path must be an absolute file path' } }, true);
        }
        if (typeof maxBytes !== 'number' || maxBytes < 1) {
          return toolResult({ error: { message: 'max_bytes must be a positive integer' } }, true);
        }
        let size: number;
        try {
          size = statSync(filePath).size;
        } catch {
          return toolResult({ error: { message: `file not found: ${filePath}` } }, true);
        }
        if (!isMediaFile(filePath)) {
          return toolResult({ error: { message: `not a media file (checked extension): ${filePath}` } }, true);
        }

        const result = VIDEO_EXTENSIONS.some((ext) =>
          filePath.toLowerCase().endsWith(ext)
        )
          ? await optimizeVideo(filePath, maxBytes)
          : await optimizeImage(filePath, maxBytes);
        return toolResult(result as unknown as Record<string, unknown>, !result.ok);
      }

      case 'platform_deployment_status': {
        const response = await apiRequest(`/deployments/${args?.deployment_id}`);
        const data = await response.json();
        return toolResult(data as Record<string, unknown>);
      }

      case 'platform_delete_site': {
        const reference = args?.site_id;
        if (typeof reference !== 'string') return toolResult({ error: { message: 'site_id is required' } }, true);
        const resolvedSiteId = await resolveSiteReference(reference);
        await apiRequest(`/sites/${resolvedSiteId}`, {
          method: 'DELETE',
        });
        return toolResult({ deleted: true, site_id: resolvedSiteId });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return toolResult({ error: { message: error instanceof Error ? error.message : String(error) } }, true);
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
