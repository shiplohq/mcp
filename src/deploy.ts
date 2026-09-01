import { createHash } from 'node:crypto';
import { exec as execCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isMediaFile } from '@shiplohq/contracts';
import { optimizeImage, optimizeVideo, VIDEO_EXTENSIONS } from './optimize.js';

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

export type ManifestFile = { path: string; size: number; sha256: string };
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
  resumeDeploymentId?: string;
  uploadConcurrency?: number;
  uploadRetries?: number;
  requestTimeoutMs?: number;
  oversized?: 'optimize' | 'skip' | 'error';
  prepared?: PreparedStaticDeployment;
  signal?: AbortSignal;
  onProgress?: (update: DeployProgress) => void | Promise<void>;
};

export type DeployProgress = {
  stage: 'build' | 'scan' | 'optimize' | 'upload' | 'finalize' | 'activate' | 'live';
  completed: number;
  total: number;
  message: string;
};

export type PreparedStaticDeployment = {
  cwd: string;
  outputRoot: string;
  files: ManifestFile[];
  skippedFiles: string[];
  optimizedFiles: string[];
  /** Internal disposable copy used when deploy-time optimization rewrites media. */
  temporaryRoot?: string;
};

export async function disposePreparedStaticDeployment(
  prepared: PreparedStaticDeployment | undefined
): Promise<void> {
  if (!prepared?.temporaryRoot) return;
  const temporaryRoot = prepared.temporaryRoot;
  prepared.temporaryRoot = undefined;
  await rm(temporaryRoot, { recursive: true, force: true });
}

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
  skipped_files: string[];
  optimized_files: string[];
  resumed: boolean;
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

async function notify(
  callback: DeployStaticOptions['onProgress'],
  update: DeployProgress
): Promise<void> {
  await callback?.(update);
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
  options: RequestInit = {},
  signal?: AbortSignal,
  timeoutMs = 30_000
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchImpl(`${apiBaseUrl}${endpoint}`, {
    ...options,
    signal: combinedSignal,
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

function isRetryable(error: unknown): boolean {
  return !(error instanceof ShiploApiError)
    || error.status === 408
    || error.status === 429
    || error.status >= 500;
}

async function withRetry<T>(attempts: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (signal?.aborted || !isRetryable(error) || attempt === attempts - 1) throw error;
      await sleep(Math.min(2_000, 200 * (2 ** attempt)) + Math.floor(Math.random() * 100));
    }
  }
  throw lastError;
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function callerAbort(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

async function sleepUntil(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw callerAbort(signal);
  await new Promise<void>((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(callerAbort(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

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
  intervalMs: number,
  signal?: AbortSignal
): Promise<LiveProbeResult> {
  const startedAt = Date.now();
  if (timeoutMs <= 0) {
    return { live: false, waitMs: 0, note: 'live check disabled (PLATFORM_LIVE_WAIT_TIMEOUT_MS=0)' };
  }
  const deadline = startedAt + timeoutMs;
  let lastState = 'unreachable';
  for (let attempt = 0; ; attempt++) {
    try {
      if (signal?.aborted) throw callerAbort(signal);
      const probeTimeout = AbortSignal.timeout(10_000);
      const response = await fetchImpl(`https://${hostname}/?_shiplo_live_probe=${attempt}`, {
        // Unique query per attempt keeps any cache out of the way; no-store
        // is implied by the URL being new every probe.
        redirect: 'follow',
        signal: signal ? AbortSignal.any([signal, probeTimeout]) : probeTimeout,
      });
      const parked = (response.headers.get('x-shiplo-parked') ?? '') === '1';
      const status = response.status;
      if (!parked && status >= 200 && status < 400) {
        return { live: true, waitMs: Date.now() - startedAt };
      }
      lastState = parked ? `placeholder (HTTP ${status})` : `HTTP ${status}`;
    } catch (error) {
      if (signal?.aborted) throw callerAbort(signal);
      lastState = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) break;
    await sleepUntil(Math.min(intervalMs, Math.max(1, deadline - Date.now())), signal);
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

export type PrepareStaticOptions = Pick<
  DeployStaticOptions,
  'cwd' | 'buildCommand' | 'outputDir' | 'apiBaseUrl' | 'apiToken' | 'fetchImpl'
  | 'oversized' | 'requestTimeoutMs' | 'signal' | 'onProgress'
>;

export async function prepareStaticDeployment(options: PrepareStaticOptions): Promise<PreparedStaticDeployment> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const buildCommand = options.buildCommand?.trim() || undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? process.env.PLATFORM_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const apiToken = options.apiToken ?? process.env.PLATFORM_API_TOKEN ?? '';
  const requestTimeoutMs = resolvePositiveConfig(options.requestTimeoutMs, process.env.PLATFORM_REQUEST_TIMEOUT_MS, 30_000);
  const prevalidatedOutputRoot = buildCommand
    ? undefined
    : await resolveOutputDirectory(cwd, options.outputDir);

  if (buildCommand) {
    await notify(options.onProgress, { stage: 'build', completed: 0, total: 1, message: 'Running static-site build' });
    const { PLATFORM_API_TOKEN: _platformApiToken, ...buildEnv } = process.env;
    const timeout = resolvePositiveConfig(undefined, process.env.PLATFORM_BUILD_TIMEOUT_MS, 10 * 60 * 1000);
    await exec(buildCommand, { cwd, env: buildEnv, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    await notify(options.onProgress, { stage: 'build', completed: 1, total: 1, message: 'Build completed' });
  }

  const outputRoot = prevalidatedOutputRoot ?? await resolveOutputDirectory(cwd, options.outputDir);
  let deployOutputRoot = outputRoot;
  let temporaryRoot: string | undefined;
  await notify(options.onProgress, { stage: 'scan', completed: 0, total: 1, message: 'Hashing deployment output' });
  let files = await collectFiles(outputRoot);
  if (files.length === 0) throw new Error('Static output directory contains no deployable files');
  const skippedFiles: string[] = [];
  const optimizedFiles: string[] = [];
  const oversized = options.oversized ?? 'error';

  if (oversized !== 'error') {
    if (!apiToken) throw new Error('PLATFORM_API_TOKEN is required to apply the oversized-file policy');
    const account = await requestJson<{ plan?: { max_file_size_bytes?: number } }>(
      fetchImpl, apiBaseUrl, apiToken, '/account', {}, options.signal, requestTimeoutMs
    );
    const limit = Number(account.plan?.max_file_size_bytes);
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('Shiplo account response did not include max_file_size_bytes');
    const tooLarge = files.filter((file) => file.size > limit);
    if (oversized === 'skip') {
      skippedFiles.push(...tooLarge.map((file) => file.path));
      const skipped = new Set(skippedFiles);
      files = files.filter((file) => !skipped.has(file.path));
    } else {
      try {
        if (tooLarge.length > 0) {
          temporaryRoot = await mkdtemp(join(tmpdir(), 'shiplo-mcp-prepared-'));
          for (const file of files) {
            const destination = resolve(temporaryRoot, ...file.path.split('/'));
            await mkdir(dirname(destination), { recursive: true });
            await copyFile(resolve(outputRoot, ...file.path.split('/')), destination);
          }
          deployOutputRoot = temporaryRoot;
        }
        for (let index = 0; index < tooLarge.length; index++) {
          const file = tooLarge[index];
          if (!isMediaFile(file.path)) {
            throw new Error(`Oversized non-media file cannot be optimized: ${file.path}`);
          }
          await notify(options.onProgress, {
            stage: 'optimize', completed: index, total: tooLarge.length, message: `Optimizing ${file.path}`,
          });
          const absolutePath = resolve(deployOutputRoot, ...file.path.split('/'));
          const result = VIDEO_EXTENSIONS.some((extension) => file.path.toLowerCase().endsWith(extension))
            ? await optimizeVideo(absolutePath, limit)
            : await optimizeImage(absolutePath, limit);
          if (!result.ok) throw new Error(result.error ?? `Could not optimize ${file.path}`);
          optimizedFiles.push(file.path);
        }
        files = await collectFiles(deployOutputRoot);
        const remaining = files.filter((file) => file.size > limit);
        if (remaining.length > 0) {
          throw new Error(`Files still exceed the plan limit after optimization: ${remaining.map((file) => file.path).join(', ')}`);
        }
      } catch (error) {
        if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
        throw error;
      }
    }
  }
  if (files.length === 0) throw new Error('Oversized-file policy removed every deployable file');
  await notify(options.onProgress, { stage: 'scan', completed: 1, total: 1, message: `Prepared ${files.length} files` });
  return { cwd, outputRoot: deployOutputRoot, files, skippedFiles, optimizedFiles, temporaryRoot };
}

export async function deployStatic(options: DeployStaticOptions): Promise<DeployStaticResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const apiBaseUrl = (options.apiBaseUrl ?? process.env.PLATFORM_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const apiToken = options.apiToken ?? process.env.PLATFORM_API_TOKEN ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!options.siteId) throw new Error('site_id is required for deployment');
  if (!apiToken) throw new Error('PLATFORM_API_TOKEN is required');

  const requestTimeoutMs = resolvePositiveConfig(options.requestTimeoutMs, process.env.PLATFORM_REQUEST_TIMEOUT_MS, 30_000);
  const prepare = () => prepareStaticDeployment({
    cwd, buildCommand: options.buildCommand, outputDir: options.outputDir,
    apiBaseUrl, apiToken, fetchImpl, oversized: options.oversized,
    requestTimeoutMs, signal: options.signal, onProgress: options.onProgress,
  });
  let prepared = options.prepared;
  if (!prepared && !options.buildCommand?.trim()) prepared = await prepare();
  let temporaryRoot = prepared?.temporaryRoot;
  try {
    const siteData = await requestJson<{ site: { hostname?: string | null } }>(
      fetchImpl, apiBaseUrl, apiToken, `/sites/${encodeURIComponent(options.siteId)}`,
      {}, options.signal, requestTimeoutMs
    );
    prepared ??= await prepare();
    temporaryRoot = prepared.temporaryRoot;
    const { outputRoot, files } = prepared;

  const manifest: Manifest = {
    files,
    total_bytes: files.reduce((total, file) => total + file.size, 0),
    file_count: files.length,
    artifact_type: 'static',
  };

  let deploymentId = options.resumeDeploymentId;
  const staged = new Map<string, { size: number; etag: string }>();
  if (deploymentId) {
    const status = await requestJson<{ deployment?: { site_id?: string; status?: string } }>(
      fetchImpl, apiBaseUrl, apiToken, `/deployments/${encodeURIComponent(deploymentId)}`,
      {}, options.signal, requestTimeoutMs
    );
    if (status.deployment?.site_id !== options.siteId) {
      throw new Error(`Deployment ${deploymentId} does not belong to site ${options.siteId}`);
    }
    if (!['created', 'uploading'].includes(status.deployment.status ?? '')) {
      throw new Error(`Deployment ${deploymentId} is not resumable (status: ${status.deployment?.status ?? 'unknown'})`);
    }
    const uploaded = await requestJson<{ files?: Array<{ path: string; size: number; etag: string }> }>(
      fetchImpl, apiBaseUrl, apiToken, `/deployments/${encodeURIComponent(deploymentId)}/files`,
      {}, options.signal, requestTimeoutMs
    );
    for (const file of uploaded.files ?? []) staged.set(file.path, { size: file.size, etag: file.etag });
  } else {
    const created = await requestJson<{ deployment?: { id?: string } }>(
      fetchImpl,
      apiBaseUrl,
      apiToken,
      `/sites/${encodeURIComponent(options.siteId)}/deployments`,
      jsonBody({ manifest }),
      options.signal,
      requestTimeoutMs
    );
    deploymentId = created.deployment?.id;
    if (!deploymentId) throw new Error('Shiplo API did not return deployment.id');
  }

  const pendingFiles = files.filter((file) => {
    const existing = staged.get(file.path);
    return !existing || existing.size !== file.size || existing.etag !== file.sha256;
  });
  let uploadedCount = files.length - pendingFiles.length;
  await notify(options.onProgress, {
    stage: 'upload', completed: uploadedCount, total: files.length,
    message: uploadedCount ? `Resuming after ${uploadedCount} previously uploaded files` : 'Uploading files',
  });
  const concurrency = Math.min(16, Math.max(1, Math.floor(options.uploadConcurrency ?? 6)));
  const attempts = Math.min(6, Math.max(1, Math.floor(options.uploadRetries ?? 2) + 1));
  let cursor = 0;
  const uploadWorker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= pendingFiles.length) return;
      const file = pendingFiles[index];
      try {
        await withRetry(attempts, async () => {
          const contents = await readValidatedFile(outputRoot, file);
          await requestJson(
            fetchImpl,
            apiBaseUrl,
            apiToken,
            `/deployments/${encodeURIComponent(deploymentId!)}/files/${encodeFilePath(file.path)}`,
            {
              method: 'PUT',
              headers: {
                'content-type': 'application/octet-stream',
                'content-length': String(contents.length),
                'x-shiplo-sha256': file.sha256,
              },
              body: contents,
            },
            options.signal,
            requestTimeoutMs
          );
        }, options.signal);
        uploadedCount++;
        await notify(options.onProgress, {
          stage: 'upload', completed: uploadedCount, total: files.length, message: `Uploaded ${file.path}`,
        });
      } catch (error) {
        throw new DeploymentPhaseError('upload', deploymentId!, file.path, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pendingFiles.length)) }, uploadWorker));

  let finalized: { release?: { id?: string } };
  try {
    await notify(options.onProgress, { stage: 'finalize', completed: 0, total: 1, message: 'Finalizing release' });
    finalized = await requestJson<{ release?: { id?: string } }>(
      fetchImpl,
      apiBaseUrl,
      apiToken,
      `/deployments/${encodeURIComponent(deploymentId)}/finalize`,
      jsonBody({ manifest }), options.signal, requestTimeoutMs
    );
  } catch (error) {
    throw new DeploymentPhaseError('finalize', deploymentId, undefined, error);
  }
  const releaseId = finalized.release?.id;
  if (!releaseId) throw new Error('Shiplo API did not return release.id');
  await notify(options.onProgress, { stage: 'finalize', completed: 1, total: 1, message: 'Release finalized' });

  let activated: { deployment?: { status?: string; release_id?: string } };
  try {
    await notify(options.onProgress, { stage: 'activate', completed: 0, total: 1, message: 'Activating release' });
    activated = await requestJson<{ deployment?: { status?: string; release_id?: string } }>(
      fetchImpl,
      apiBaseUrl,
      apiToken,
      `/deployments/${encodeURIComponent(deploymentId)}/activate`,
      jsonBody({}), options.signal, requestTimeoutMs
    );
  } catch (error) {
    throw new DeploymentPhaseError('activate', deploymentId, undefined, error);
  }
  if (activated.deployment?.status !== 'active') {
    throw new Error(`Shiplo API did not activate deployment ${deploymentId}`);
  }
  await notify(options.onProgress, { stage: 'activate', completed: 1, total: 1, message: 'Release active' });

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
    await notify(options.onProgress, { stage: 'live', completed: 0, total: 1, message: 'Waiting for the public URL' });
    liveProbe = await waitForLive(hostname, fetchImpl, liveWaitTimeoutMs, liveProbeIntervalMs, options.signal);
    await notify(options.onProgress, {
      stage: 'live', completed: 1, total: 1,
      message: liveProbe.live ? 'Public URL is live' : 'Public URL wait timed out',
    });
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
    skipped_files: prepared.skippedFiles,
    optimized_files: prepared.optimizedFiles,
    resumed: Boolean(options.resumeDeploymentId),
    live: liveProbe.live,
    live_wait_ms: liveProbe.waitMs,
    ...(liveProbe.note ? { live_note: liveProbe.note } : {}),
    };
  } finally {
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
      if (prepared?.temporaryRoot === temporaryRoot) prepared.temporaryRoot = undefined;
    }
  }
}

/** First non-negative finite number wins: option, then env, then default. */
function resolveLiveConfig(optionValue: number | undefined, envValue: string | undefined, fallback: number): number {
  for (const candidate of [optionValue, envValue === undefined ? undefined : Number(envValue)]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return fallback;
}

function resolvePositiveConfig(optionValue: number | undefined, envValue: string | undefined, fallback: number): number {
  const value = resolveLiveConfig(optionValue, envValue, fallback);
  return value > 0 ? value : fallback;
}
