import { createHash } from 'node:crypto';
import { exec as execCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execCallback);
const DEFAULT_API_BASE_URL = 'https://shiplo.site/v1';
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.azure',
  '.gcloud',
  '.claude',
  '.codex',
  '.shiplo',
  'node_modules',
]);
const EXCLUDED_CREDENTIAL_FILES = new Set([
  '.mcp.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'service-account.json',
  'id_rsa',
  'id_ed25519',
]);
const EXCLUDED_CREDENTIAL_EXTENSIONS = ['.key', '.pem', '.p12', '.pfx'];

type ManifestFile = { path: string; size: number; sha256: string };
type Manifest = {
  files: ManifestFile[];
  total_bytes: number;
  file_count: number;
  artifact_type: 'static';
};

export type DeployStaticOptions = {
  siteId: string;
  buildCommand?: string;
  outputDir?: string;
  cwd?: string;
  apiBaseUrl?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
  /** How long to poll the URL for the edge to start serving (0 disables the wait). */
  liveWaitTimeoutMs?: number;
  /** Delay between live probes. */
  liveProbeIntervalMs?: number;
};

export type DeployStaticResult = {
  deployment_id: string;
  release_id: string;
  status: 'active';
  site_id: string;
  hostname: string | null;
  url: string | null;
  file_count: number;
  total_bytes: number;
  /** True when a probe of the URL confirmed the site itself is being served. */
  live: boolean;
  /** Time spent waiting for the edge (0 when disabled or no hostname). */
  live_wait_ms: number;
  /** Why `live` is false — the deploy itself is still committed and active. */
  live_note?: string;
};

export class ShiploApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
    public readonly details: unknown
  ) {
    super(message);
    this.name = 'ShiploApiError';
  }
}

class DeploymentPhaseError extends Error {
  constructor(
    public readonly phase: 'upload' | 'finalize' | 'activate',
    public readonly deploymentId: string,
    public readonly file: string | undefined,
    public readonly originalError: unknown
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = 'DeploymentPhaseError';
  }
}

export function serializeDeployError(error: unknown): { error: Record<string, unknown> } {
  if (error instanceof DeploymentPhaseError) {
    const serialized = serializeDeployError(error.originalError).error;
    return {
      error: {
        ...serialized,
        deployment_id: error.deploymentId,
        phase: error.phase,
        ...(error.file ? { file: error.file } : {}),
      },
    };
  }
  if (error instanceof ShiploApiError) {
    return {
      error: {
        status: error.status,
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return {
    error: { message: error instanceof Error ? error.message : String(error) },
  };
}

function shouldExclude(name: string, isDirectory: boolean): boolean {
  const lowerName = name.toLowerCase();
  if (isDirectory) return EXCLUDED_DIRECTORIES.has(lowerName);
  return (
    EXCLUDED_CREDENTIAL_FILES.has(lowerName) ||
    lowerName === '.env' ||
    lowerName.startsWith('.env.') ||
    EXCLUDED_CREDENTIAL_EXTENSIONS.some((extension) => lowerName.endsWith(extension))
  );
}

function toManifestPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

async function collectFiles(root: string, directory = root): Promise<ManifestFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: ManifestFile[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (shouldExclude(entry.name, entry.isDirectory())) continue;
    const absolutePath = resolve(directory, entry.name);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Deployment output cannot contain symbolic links: ${toManifestPath(root, absolutePath)}`);
    }
    if (stats.isDirectory()) {
      files.push(...await collectFiles(root, absolutePath));
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Deployment output contains an unsupported file type: ${toManifestPath(root, absolutePath)}`);
    }
    const contents = await readFile(absolutePath);
    files.push({
      path: toManifestPath(root, absolutePath),
      size: contents.length,
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
  }

  return files;
}

async function detectOutputDirectory(cwd: string): Promise<string> {
  for (const candidate of ['dist', 'out', 'build']) {
    const absolutePath = resolve(cwd, candidate);
    if (existsSync(absolutePath)) return absolutePath;
  }
  if (existsSync(resolve(cwd, 'index.html'))) return cwd;
  throw new Error('Could not detect a static output directory. Pass output_dir explicitly.');
}

async function resolveOutputDirectory(cwd: string, outputDir?: string): Promise<string> {
  const absolutePath = outputDir ? resolve(cwd, outputDir) : await detectOutputDirectory(cwd);
  const pathFromProject = relative(cwd, absolutePath);
  if (pathFromProject === '..' || pathFromProject.startsWith(`..${sep}`) || isAbsolute(pathFromProject)) {
    throw new Error('output_dir must stay inside the current project directory');
  }
  const stats = await lstat(absolutePath).catch(() => null);
  if (stats?.isSymbolicLink()) {
    throw new Error(`Static output directory cannot be a symbolic link: ${outputDir ?? pathFromProject}`);
  }
  if (!stats?.isDirectory()) throw new Error(`Static output directory not found: ${outputDir ?? pathFromProject}`);
  const realProject = await realpath(cwd);
  const realOutput = await realpath(absolutePath);
  const realPathFromProject = relative(realProject, realOutput);
  if (
    realPathFromProject === '..' ||
    realPathFromProject.startsWith(`..${sep}`) ||
    isAbsolute(realPathFromProject)
  ) {
    throw new Error('Static output directory resolves outside the current project directory');
  }
  return absolutePath;
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  apiToken: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetchImpl(`${apiBaseUrl}${endpoint}`, {
    ...options,
    headers: { authorization: `Bearer ${apiToken}`, ...options.headers },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText })) as {
      error?: { code?: string; message?: string; details?: unknown };
      message?: string;
    };
    throw new ShiploApiError(
      response.status,
      error.error?.code,
      error.error?.message ?? error.message ?? `Shiplo API returned ${response.status}`,
      error.error?.details
    );
  }
  return response.json() as Promise<T>;
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type LiveProbeResult = { live: boolean; waitMs: number; note?: string };

/**
 * Activation commits in the platform API before edge reconciliation attaches
 * the hostname to the web server (a background loop ticks every few seconds —
 * this gap is why a freshly returned URL could 404/placeholder minutes ago).
 * Probe the public URL until it stops answering the platform placeholder.
 *
 * The placeholder carries the `X-Shiplo-Parked` response header; a 404/5xx
 * also counts as not-yet-live for edges that predate the header. A timeout is
 * NOT a deploy failure — the release is active and the edge applies routing on
 * its own — so callers report the URL with `live: false` and a note.
 */
export async function waitForLive(
  hostname: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  intervalMs: number
): Promise<LiveProbeResult> {
  const startedAt = Date.now();
  if (timeoutMs <= 0) {
    return { live: false, waitMs: 0, note: 'live check disabled (PLATFORM_LIVE_WAIT_TIMEOUT_MS=0)' };
  }
  const deadline = startedAt + timeoutMs;
  let lastState = 'unreachable';
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchImpl(`https://${hostname}/?_shiplo_live_probe=${attempt}`, {
        // Unique query per attempt keeps any cache out of the way; no-store
        // is implied by the URL being new every probe.
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      });
      const parked = (response.headers.get('x-shiplo-parked') ?? '') === '1';
      const status = response.status;
      if (!parked && status >= 200 && status < 400) {
        return { live: true, waitMs: Date.now() - startedAt };
      }
      lastState = parked ? `placeholder (HTTP ${status})` : `HTTP ${status}`;
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  return {
    live: false,
    waitMs: Date.now() - startedAt,
    note:
      `URL not verified live within ${timeoutMs}ms (last probe: ${lastState}). ` +
      'The deploy is active — edge routing applies on the next reconcile tick, so the URL should work shortly.',
  };
}

function encodeFilePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function readValidatedFile(outputRoot: string, file: ManifestFile): Promise<Buffer> {
  const absolutePath = resolve(outputRoot, ...file.path.split('/'));
  const stats = await lstat(absolutePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Deployment file changed after the manifest was created: ${file.path}`);
  }
  const contents = await readFile(absolutePath);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  if (contents.length !== file.size || sha256 !== file.sha256) {
    throw new Error(`Deployment file changed after the manifest was created: ${file.path}`);
  }
  return contents;
}

export async function deployStatic(options: DeployStaticOptions): Promise<DeployStaticResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const apiBaseUrl = (options.apiBaseUrl ?? process.env.PLATFORM_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const apiToken = options.apiToken ?? process.env.PLATFORM_API_TOKEN ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!options.siteId) throw new Error('site_id is required for deployment');
  if (!apiToken) throw new Error('PLATFORM_API_TOKEN is required');

  const buildCommand = options.buildCommand?.trim() || undefined;
  const prevalidatedOutputRoot = buildCommand
    ? undefined
    : await resolveOutputDirectory(cwd, options.outputDir);

  const siteData = await requestJson<{ site: { hostname?: string | null } }>(
    fetchImpl, apiBaseUrl, apiToken, `/sites/${encodeURIComponent(options.siteId)}`
  );

  if (buildCommand) {
    const { PLATFORM_API_TOKEN: _platformApiToken, ...buildEnv } = process.env;
    const configuredTimeout = Number(process.env.PLATFORM_BUILD_TIMEOUT_MS ?? 10 * 60 * 1000);
    const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 10 * 60 * 1000;
    await exec(buildCommand, {
      cwd,
      env: buildEnv,
      timeout,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  const outputRoot = prevalidatedOutputRoot ?? await resolveOutputDirectory(cwd, options.outputDir);
  const files = await collectFiles(outputRoot);
  if (files.length === 0) throw new Error('Static output directory contains no deployable files');

  const manifest: Manifest = {
    files,
    total_bytes: files.reduce((total, file) => total + file.size, 0),
    file_count: files.length,
    artifact_type: 'static',
  };

  const created = await requestJson<{ deployment?: { id?: string } }>(
    fetchImpl,
    apiBaseUrl,
    apiToken,
    `/sites/${encodeURIComponent(options.siteId)}/deployments`,
    jsonBody({ manifest })
  );
  const deploymentId = created.deployment?.id;
  if (!deploymentId) throw new Error('Shiplo API did not return deployment.id');

  for (const file of files) {
    try {
      const contents = await readValidatedFile(outputRoot, file);
      await requestJson(
        fetchImpl,
        apiBaseUrl,
        apiToken,
        `/deployments/${encodeURIComponent(deploymentId)}/files/${encodeFilePath(file.path)}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(contents.length),
          },
          body: contents,
        }
      );
    } catch (error) {
      throw new DeploymentPhaseError('upload', deploymentId, file.path, error);
    }
  }

  let finalized: { release?: { id?: string } };
  try {
    finalized = await requestJson<{ release?: { id?: string } }>(
      fetchImpl,
      apiBaseUrl,
      apiToken,
      `/deployments/${encodeURIComponent(deploymentId)}/finalize`,
      jsonBody({ manifest })
    );
  } catch (error) {
    throw new DeploymentPhaseError('finalize', deploymentId, undefined, error);
  }
  const releaseId = finalized.release?.id;
  if (!releaseId) throw new Error('Shiplo API did not return release.id');

  let activated: { deployment?: { status?: string; release_id?: string } };
  try {
    activated = await requestJson<{ deployment?: { status?: string; release_id?: string } }>(
      fetchImpl,
      apiBaseUrl,
      apiToken,
      `/deployments/${encodeURIComponent(deploymentId)}/activate`,
      jsonBody({})
    );
  } catch (error) {
    throw new DeploymentPhaseError('activate', deploymentId, undefined, error);
  }
  if (activated.deployment?.status !== 'active') {
    throw new Error(`Shiplo API did not activate deployment ${deploymentId}`);
  }

  const hostname = siteData.site.hostname ?? null;

  // Hold the URL back until the edge actually serves the site — returning it
  // the moment activation commits is what made fresh URLs 404/placeholder.
  const liveWaitTimeoutMs = resolveLiveConfig(
    options.liveWaitTimeoutMs,
    process.env.PLATFORM_LIVE_WAIT_TIMEOUT_MS,
    75_000
  );
  const liveProbeIntervalMs = resolveLiveConfig(
    options.liveProbeIntervalMs,
    process.env.PLATFORM_LIVE_PROBE_INTERVAL_MS,
    2_000
  );
  let liveProbe: LiveProbeResult = { live: false, waitMs: 0, note: 'site has no hostname attached' };
  if (hostname) {
    liveProbe = await waitForLive(hostname, fetchImpl, liveWaitTimeoutMs, liveProbeIntervalMs);
  }

  return {
    deployment_id: deploymentId,
    release_id: activated.deployment.release_id ?? releaseId,
    status: 'active',
    site_id: options.siteId,
    hostname,
    url: hostname ? `https://${hostname}` : null,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
    live: liveProbe.live,
    live_wait_ms: liveProbe.waitMs,
    ...(liveProbe.note ? { live_note: liveProbe.note } : {}),
  };
}

/** First non-negative finite number wins: option, then env, then default. */
function resolveLiveConfig(optionValue: number | undefined, envValue: string | undefined, fallback: number): number {
  for (const candidate of [optionValue, envValue === undefined ? undefined : Number(envValue)]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return fallback;
}
