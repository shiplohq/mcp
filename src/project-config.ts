import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

export const SHIPLO_CONFIG_VERSION = 1;

export type ShiploProjectConfig = {
  version: 1;
  project_name: string;
  site_id: string;
  subdomain: string;
  build_command: string | null;
  output_dir: string;
};

export type ProjectInspection = {
  project_name: string;
  preferred_subdomain: string;
  build_command: string | null;
  output_dir: string | null;
  missing_fields: string[];
};

type PackageJson = {
  name?: unknown;
  scripts?: { build?: unknown };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

function normalizeSubdomain(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return normalized.length >= 3 ? normalized : `${normalized || 'site'}-site`;
}

export function projectConfigPath(cwd: string): string {
  return join(resolve(cwd), '.shiplo', 'project.json');
}

async function assertSafeShiploDirectory(cwd: string, create: boolean): Promise<string | null> {
  const projectRoot = resolve(cwd);
  const directory = join(projectRoot, '.shiplo');
  let stats = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats && create) {
    await mkdir(directory, { recursive: false });
    stats = await lstat(directory);
  }
  if (!stats) return null;
  if (stats.isSymbolicLink()) {
    throw new Error('Shiplo configuration directory cannot be a symbolic link');
  }
  if (!stats.isDirectory()) {
    throw new Error('Shiplo configuration path must be a directory');
  }
  const realProject = await realpath(projectRoot);
  const realDirectory = await realpath(directory);
  const pathFromProject = relative(realProject, realDirectory);
  if (pathFromProject === '..' || pathFromProject.startsWith(`..${sep}`)) {
    throw new Error('Shiplo configuration directory resolves outside the project');
  }
  return directory;
}

export async function inspectProject(cwd: string): Promise<ProjectInspection> {
  const projectRoot = resolve(cwd);
  let packageJson: PackageJson | null = null;
  try {
    packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    packageJson = null;
  }

  const packageName = typeof packageJson?.name === 'string'
    ? packageJson.name.replace(/^@[^/]+\//, '').trim()
    : '';
  const projectName = packageName || basename(projectRoot);
  const hasBuild = typeof packageJson?.scripts?.build === 'string';
  const buildScript = hasBuild ? packageJson?.scripts?.build as string : '';
  const dependencies = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  let outputDir: string | null = null;
  if (typeof dependencies.next === 'string') {
    for (const configName of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
      try {
        const nextConfig = await readFile(join(projectRoot, configName), 'utf8');
        if (/output\s*:\s*['"]export['"]/.test(nextConfig)) {
          outputDir = 'out';
          break;
        }
      } catch {
        // Try the next supported Next configuration filename.
      }
    }
  }
  for (const candidate of ['dist', 'out', 'build']) {
    if (existsSync(join(projectRoot, candidate))) {
      outputDir = candidate;
      break;
    }
  }
  if (outputDir === null && (
    typeof dependencies.vite === 'string'
    || typeof dependencies.astro === 'string'
    || /\b(vite|astro)\b/.test(buildScript)
  )) outputDir = 'dist';
  if (outputDir === null && (
    typeof dependencies['react-scripts'] === 'string'
    || /\breact-scripts\b/.test(buildScript)
  )) outputDir = 'build';
  if (!hasBuild && existsSync(join(projectRoot, 'index.html'))) outputDir = '.';

  return {
    project_name: projectName,
    preferred_subdomain: normalizeSubdomain(projectName),
    build_command: hasBuild ? 'npm run build' : null,
    output_dir: outputDir,
    missing_fields: outputDir === null ? ['output_dir'] : [],
  };
}

function validateOutputDirectory(cwd: string, outputDir: string): void {
  const normalized = outputDir.trim();
  if (!normalized) throw new Error('Shiplo project output_dir must not be empty');
  const projectRoot = resolve(cwd);
  const pathFromRoot = relative(projectRoot, resolve(projectRoot, normalized));
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error('Shiplo project output_dir must stay inside the current project');
  }
}

export async function writeProjectConfig(cwd: string, config: ShiploProjectConfig): Promise<string> {
  validateOutputDirectory(cwd, config.output_dir);
  const configPath = projectConfigPath(cwd);
  const directory = await assertSafeShiploDirectory(cwd, true);
  if (!directory) throw new Error('Failed to create Shiplo configuration directory');
  const temporaryPath = join(directory, `.project-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPath, configPath);
  return configPath;
}

function validateProjectConfig(cwd: string, value: unknown): ShiploProjectConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Shiplo project config: expected a JSON object');
  }
  const config = value as Record<string, unknown>;
  if (typeof config.version !== 'number') {
    throw new Error('Invalid Shiplo project config: version must be a number');
  }
  if (config.version > SHIPLO_CONFIG_VERSION) {
    throw new Error(
      `Shiplo project config uses newer version ${config.version}; upgrade @shiplohq/mcp`
    );
  }
  if (config.version !== SHIPLO_CONFIG_VERSION) {
    throw new Error(`Unsupported Shiplo project config version: ${config.version}`);
  }
  for (const field of ['project_name', 'site_id', 'subdomain', 'output_dir'] as const) {
    if (typeof config[field] !== 'string' || !config[field].trim()) {
      throw new Error(`Invalid Shiplo project config: ${field} must be a non-empty string`);
    }
  }
  if (config.build_command !== null && typeof config.build_command !== 'string') {
    throw new Error('Invalid Shiplo project config: build_command must be a string or null');
  }
  validateOutputDirectory(cwd, config.output_dir as string);
  return {
    version: 1,
    project_name: config.project_name as string,
    site_id: config.site_id as string,
    subdomain: config.subdomain as string,
    build_command: config.build_command as string | null,
    output_dir: config.output_dir as string,
  };
}

export async function readProjectConfig(cwd: string): Promise<ShiploProjectConfig | null> {
  const directory = await assertSafeShiploDirectory(cwd, false);
  if (!directory) return null;
  const configPath = projectConfigPath(cwd);
  let contents: string;
  try {
    contents = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid Shiplo project config JSON: ${configPath}`);
  }
  return validateProjectConfig(cwd, parsed);
}
