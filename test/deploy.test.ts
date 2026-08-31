import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { deployStatic, waitForLive } from '../src/deploy';

const TMP = mkdtempSync(join(tmpdir(), 'shiplo-mcp-deploy-'));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

type RecordedRequest = {
  method: string;
  url: string;
  authorization?: string;
  contentType?: string;
  body: Buffer;
};

const requests: RecordedRequest[] = [];
let baseUrl = '';

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const api = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  requests.push({
    method: request.method ?? '',
    url: request.url ?? '',
    authorization: request.headers.authorization,
    contentType: request.headers['content-type'],
    body,
  });

  if (request.method === 'POST' && request.url === '/v1/sites') {
    const input = JSON.parse(body.toString('utf8')) as { name: string; preferred_subdomain?: string };
    if (input.preferred_subdomain === 'taken-project') {
      return json(response, 409, {
        error: { code: 'HOSTNAME_NOT_AVAILABLE', message: 'Hostname is not available' },
      });
    }
    const slug = input.preferred_subdomain ?? 'generated-project-a1b2c3d4e5f6';
    return json(response, 201, {
      site: {
        id: 'auto-site',
        name: input.name,
        slug,
        status: 'active',
        routing_mode: 'static',
      },
      hostnames: [{ hostname: `${slug}.shiplo.site`, is_primary: true }],
    });
  }
  if (request.method === 'GET' && request.url === '/v1/sites/auto-site') {
    return json(response, 200, {
      site: { id: 'auto-site', name: 'fixture-project', slug: 'fixture-project', hostname: 'fixture-project.shiplo.site' },
    });
  }
  if (request.method === 'GET' && request.url === '/v1/sites/stale-site') {
    return json(response, 404, {
      error: { code: 'NOT_FOUND', message: 'Site not found' },
    });
  }
  if (request.method === 'POST' && request.url === '/v1/sites/auto-site/deployments') {
    return json(response, 201, { deployment: { id: 'dep-auto' } });
  }
  if (request.method === 'PUT' && request.url?.startsWith('/v1/deployments/dep-auto/files/')) {
    return json(response, 200, { uploaded: true });
  }
  if (request.method === 'POST' && request.url === '/v1/deployments/dep-auto/finalize') {
    return json(response, 200, { release: { id: 'rel-auto' } });
  }
  if (request.method === 'POST' && request.url === '/v1/deployments/dep-auto/activate') {
    return json(response, 200, {
      deployment: { id: 'dep-auto', release_id: 'rel-auto', status: 'active' },
    });
  }

  if (request.method === 'GET' && request.url === '/v1/sites/site-123') {
    return json(response, 200, {
      site: { id: 'site-123', name: 'Fixture site', hostname: 'fixture.shiplo.site' },
    });
  }
  if (request.method === 'GET' && request.url === '/v1/sites/quota-site') {
    return json(response, 200, {
      site: { id: 'quota-site', name: 'Quota site', hostname: 'quota.shiplo.site' },
    });
  }
  if (request.method === 'GET' && request.url === '/v1/sites/fail-site') {
    return json(response, 200, {
      site: { id: 'fail-site', name: 'Fail site', hostname: 'fail.shiplo.site' },
    });
  }
  if (request.method === 'POST' && request.url === '/v1/sites/fail-site/deployments') {
    return json(response, 201, { deployment: { id: 'dep-fail' } });
  }
  if (request.method === 'PUT' && request.url?.startsWith('/v1/deployments/dep-fail/files/')) {
    return json(response, 500, {
      error: { code: 'UPLOAD_FAILED', message: 'Storage write failed', details: { retryable: true } },
    });
  }
  if (request.method === 'POST' && request.url === '/v1/sites/quota-site/deployments') {
    return json(response, 400, {
      error: {
        code: 'FILE_SIZE_LIMIT_EXCEEDED',
        message: 'One or more files exceed the plan limit',
        details: {
          limit: 10,
          files: [{ path: 'index.html', size: 25, is_media: false }],
        },
      },
    });
  }
  if (request.method === 'POST' && request.url === '/v1/sites/site-123/deployments') {
    return json(response, 201, {
      deployment: { id: 'dep-123', site_id: 'site-123', status: 'created' },
      upload_instructions: { mode: 'proxy', base_url: '/v1/deployments/dep-123/files' },
    });
  }
  if (request.method === 'PUT' && request.url?.startsWith('/v1/deployments/dep-123/files/')) {
    return json(response, 200, { uploaded: true });
  }
  if (request.method === 'POST' && request.url === '/v1/deployments/dep-123/finalize') {
    return json(response, 200, {
      release: { id: 'rel-123', deployment_id: 'dep-123', status: 'validated' },
    });
  }
  if (request.method === 'POST' && request.url === '/v1/deployments/dep-123/activate') {
    return json(response, 200, {
      deployment: { id: 'dep-123', release_id: 'rel-123', status: 'active' },
    });
  }

  return json(response, 404, { error: { message: 'Unexpected test request' } });
});

before(async () => {
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    api.close((error) => (error ? reject(error) : resolve()))
  );
  rmSync(TMP, { recursive: true, force: true });
});

test('first deployment creates project config before building and needs no arguments', async () => {
  requests.length = 0;
  const project = mkdtempSync(join(TMP, 'first-deploy-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'fixture-project',
    scripts: { build: 'node build.mjs' },
    devDependencies: { vite: '^7.0.0' },
  }));
  writeFileSync(join(project, 'build.mjs'), [
    "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
    "if (!existsSync('.shiplo/project.json')) throw new Error('Shiplo config missing before build');",
    "mkdirSync('dist', { recursive: true });",
    "writeFileSync('dist/index.html', '<h1>First deploy</h1>');",
  ].join('\n'));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI],
    cwd: project,
    env: {
      ...process.env,
      PLATFORM_API_BASE_URL: baseUrl,
      PLATFORM_API_TOKEN: 'shp_test_token',
      // Deployed fixtures have no real edge behind them — skip the live-URL wait.
      PLATFORM_LIVE_WAIT_TIMEOUT_MS: '0',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'first-deploy-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'platform_deploy_static',
      arguments: {},
    });

    assert.equal(result.isError, undefined);
    const content = result.content[0];
    assert.equal(content.type, 'text');
    assert.ok('text' in content);
    assert.equal(JSON.parse(content.text).site_id, 'auto-site');
  } finally {
    await client.close();
  }

  assert.deepEqual(JSON.parse(readFileSync(join(project, '.shiplo', 'project.json'), 'utf8')), {
    version: 1,
    project_name: 'fixture-project',
    site_id: 'auto-site',
    subdomain: 'fixture-project',
    build_command: 'npm run build',
    output_dir: 'dist',
  });
  assert.deepEqual(
    requests.map(({ method, url }) => `${method} ${url}`),
    [
      'POST /v1/sites',
      'GET /v1/sites/auto-site',
      'POST /v1/sites/auto-site/deployments',
      'PUT /v1/deployments/dep-auto/files/index.html',
      'POST /v1/deployments/dep-auto/finalize',
      'POST /v1/deployments/dep-auto/activate',
    ]
  );
});

test('later deployment reuses saved project config without creating another site', async () => {
  requests.length = 0;
  const project = mkdtempSync(join(TMP, 'saved-config-'));
  mkdirSync(join(project, '.shiplo'));
  mkdirSync(join(project, 'dist'));
  writeFileSync(join(project, 'dist', 'index.html'), '<h1>Saved config deploy</h1>');
  writeFileSync(join(project, '.shiplo', 'project.json'), JSON.stringify({
    version: 1,
    project_name: 'Saved fixture',
    site_id: 'site-123',
    subdomain: 'fixture',
    build_command: null,
    output_dir: 'dist',
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI],
    cwd: project,
    env: {
      ...process.env,
      PLATFORM_API_BASE_URL: baseUrl,
      PLATFORM_API_TOKEN: 'shp_test_token',
      // Deployed fixtures have no real edge behind them — skip the live-URL wait.
      PLATFORM_LIVE_WAIT_TIMEOUT_MS: '0',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'saved-config-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'platform_deploy_static', arguments: {} });
    assert.equal(result.isError, undefined);
    const content = result.content[0];
    assert.equal(content.type, 'text');
    assert.ok('text' in content);
    assert.equal(JSON.parse(content.text).site_id, 'site-123');
  } finally {
    await client.close();
  }

  assert.equal(requests.some(({ method, url }) => method === 'POST' && url === '/v1/sites'), false);
});

test('platform_inspect_project reports real project metadata without creating config', async () => {
  const project = mkdtempSync(join(TMP, 'inspect-project-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: '@fixture/inspect-me',
    scripts: { build: 'vite build' },
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI],
    cwd: project,
    env: { ...process.env, PLATFORM_API_TOKEN: 'shp_test_token' } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'inspect-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'platform_inspect_project', arguments: {} });
    assert.equal(result.isError, undefined);
    const content = result.content[0];
    assert.equal(content.type, 'text');
    assert.ok('text' in content);
    assert.deepEqual(JSON.parse(content.text), {
      configured: false,
      config_path: join(project, '.shiplo', 'project.json'),
      project_name: 'inspect-me',
      preferred_subdomain: 'inspect-me',
      build_command: 'npm run build',
      output_dir: 'dist',
      missing_fields: [],
      site_id: null,
      subdomain: null,
    });
    assert.equal(existsSync(join(project, '.shiplo')), false);
  } finally {
    await client.close();
  }
});

test('ambiguous project stops before site creation and identifies the missing field', async () => {
  requests.length = 0;
  const project = mkdtempSync(join(TMP, 'ambiguous-project-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI],
    cwd: project,
    env: {
      ...process.env,
      PLATFORM_API_BASE_URL: baseUrl,
      PLATFORM_API_TOKEN: 'shp_test_token',
      // Deployed fixtures have no real edge behind them — skip the live-URL wait.
      PLATFORM_LIVE_WAIT_TIMEOUT_MS: '0',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ambiguous-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'platform_deploy_static', arguments: {} });
    assert.equal(result.isError, true);
    const content = result.content[0];
    assert.equal(content.type, 'text');
    assert.ok('text' in content);
    assert.deepEqual(JSON.parse(content.text), {
      error: {
        code: 'PROJECT_CONFIG_REQUIRED',
        message: 'Shiplo could not safely detect all deployment settings',
        config_path: join(project, '.shiplo', 'project.json'),
        missing_fields: ['output_dir'],
      },
    });
  } finally {
    await client.close();
  }
  assert.equal(requests.length, 0);
  assert.equal(existsSync(join(project, '.shiplo')), false);
});

test('saved site is verified before its build command runs', async () => {
  requests.length = 0;
  const project = mkdtempSync(join(TMP, 'stale-site-'));
  mkdirSync(join(project, '.shiplo'));
  writeFileSync(join(project, '.shiplo', 'project.json'), JSON.stringify({
    version: 1,
    project_name: 'Stale fixture',
    site_id: 'stale-site',
    subdomain: 'stale-fixture',
    build_command: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('build-ran.txt', 'yes')"`,
    output_dir: 'dist',
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI],
    cwd: project,
    env: {
      ...process.env,
      PLATFORM_API_BASE_URL: baseUrl,
      PLATFORM_API_TOKEN: 'shp_test_token',
      // Deployed fixtures have no real edge behind them — skip the live-URL wait.
      PLATFORM_LIVE_WAIT_TIMEOUT_MS: '0',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stale-site-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'platform_deploy_static', arguments: {} });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
  }
  assert.equal(existsSync(join(project, 'build-ran.txt')), false);
  assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
    'GET /v1/sites/stale-site',
  ]);
});

test('first deployment retries once without preferred subdomain when it is unavailable', async () => {
  requests.length = 0;
  const project = mkdtempSync(join(TMP, 'taken-project-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'taken-project' }));
  writeFileSync(join(project, 'index.html'), '<h1>Collision fallback</h1>');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI],
    cwd: project,
    env: {
      ...process.env,
      PLATFORM_API_BASE_URL: baseUrl,
      PLATFORM_API_TOKEN: 'shp_test_token',
      // Deployed fixtures have no real edge behind them — skip the live-URL wait.
      PLATFORM_LIVE_WAIT_TIMEOUT_MS: '0',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'collision-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'platform_deploy_static', arguments: {} });
    assert.equal(result.isError, undefined);
  } finally {
    await client.close();
  }

  const creates = requests.filter(({ method, url }) => method === 'POST' && url === '/v1/sites');
  assert.equal(creates.length, 2);
  assert.equal(JSON.parse(creates[0].body.toString('utf8')).preferred_subdomain, 'taken-project');
  assert.equal('preferred_subdomain' in JSON.parse(creates[1].body.toString('utf8')), false);
  assert.equal(
    JSON.parse(readFileSync(join(project, '.shiplo', 'project.json'), 'utf8')).subdomain,
    'generated-project-a1b2c3d4e5f6'
  );
});

test('platform_deploy_static uploads files and activates the created deployment', async () => {
  requests.length = 0;
  const project = mkdtempSync(join(TMP, 'success-'));
  const files = new Map([
    ['index.html', Buffer.from('<h1>Shiplo fixture</h1>')],
    ['assets/app.js', Buffer.from('console.log("fixture")')],
  ]);
  for (const [relativePath, contents] of files) {
    const absolutePath = join(project, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  writeFileSync(join(project, '.env'), 'SECRET_THAT_MUST_NOT_BE_UPLOADED=true');
  writeFileSync(join(project, '.mcp.json'), '{"ops_token":"must-not-upload"}');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI],
    cwd: project,
    env: {
      ...process.env,
      PLATFORM_API_BASE_URL: baseUrl,
      PLATFORM_API_TOKEN: 'shp_test_token',
      // Deployed fixtures have no real edge behind them — skip the live-URL wait.
      PLATFORM_LIVE_WAIT_TIMEOUT_MS: '0',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'deploy-test-client', version: '1.0.0' });
  const buildCommand = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('.env.build-token', process.env.PLATFORM_API_TOKEN || '')"`;

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'platform_deploy_static',
      arguments: { site_id: 'site-123', output_dir: '.', build_command: buildCommand },
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    const content = result.content[0];
    assert.equal(content.type, 'text');
    assert.ok('text' in content);
    assert.deepEqual(JSON.parse(content.text), {
      deployment_id: 'dep-123',
      release_id: 'rel-123',
      status: 'active',
      site_id: 'site-123',
      hostname: 'fixture.shiplo.site',
      url: 'https://fixture.shiplo.site',
      file_count: 2,
      total_bytes: 45,
      live: false,
      live_wait_ms: 0,
      live_note: 'live check disabled (PLATFORM_LIVE_WAIT_TIMEOUT_MS=0)',
    });
  } finally {
    await client.close();
  }

  assert.equal(readFileSync(join(project, '.env.build-token'), 'utf8'), '');
  assert.deepEqual(JSON.parse(readFileSync(join(project, '.shiplo', 'project.json'), 'utf8')), {
    version: 1,
    project_name: project.split(/[/\\]/).at(-1),
    site_id: 'site-123',
    subdomain: 'fixture',
    build_command: buildCommand,
    output_dir: '.',
  });

  assert.deepEqual(
    requests.map(({ method, url }) => `${method} ${url}`),
    [
      'GET /v1/sites/site-123',
      'GET /v1/sites/site-123',
      'POST /v1/sites/site-123/deployments',
      'PUT /v1/deployments/dep-123/files/assets/app.js',
      'PUT /v1/deployments/dep-123/files/index.html',
      'POST /v1/deployments/dep-123/finalize',
      'POST /v1/deployments/dep-123/activate',
    ]
  );
  assert.ok(requests.every((request) => request.authorization === 'Bearer shp_test_token'));

  const manifest = {
    files: [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, contents]) => ({
        path,
        size: contents.length,
        sha256: createHash('sha256').update(contents).digest('hex'),
      })),
    total_bytes: 45,
    file_count: 2,
    artifact_type: 'static',
  };
  assert.deepEqual(JSON.parse(requests[2].body.toString('utf8')), { manifest });
  assert.deepEqual(JSON.parse(requests[5].body.toString('utf8')), { manifest });
  assert.equal(requests[3].contentType, 'application/octet-stream');
  assert.deepEqual(requests[3].body, files.get('assets/app.js'));
  assert.deepEqual(requests[4].body, files.get('index.html'));
});

test('auto-detected output rejects a symlink that escapes the project', async () => {
  const project = mkdtempSync(join(tmpdir(), 'shiplo-mcp-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'shiplo-mcp-outside-'));
  writeFileSync(join(outside, 'credential.txt'), 'must-not-upload');
  symlinkSync(outside, join(project, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  let fetchCalled = false;

  try {
    await assert.rejects(
      deployStatic({
        siteId: 'site-123',
        cwd: project,
        apiToken: 'shp_test_token',
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error('network should not be reached');
        },
      }),
      /symbolic link/i
    );
    assert.equal(fetchCalled, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('deployment aborts if a file changes after the manifest is created', async () => {
  const project = mkdtempSync(join(tmpdir(), 'shiplo-mcp-mutating-'));
  const indexPath = join(project, 'index.html');
  writeFileSync(indexPath, 'original-public-content');
  let uploadedBody: string | null = null;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === undefined && url.pathname === '/v1/sites/site-123') {
      return Response.json({ site: { hostname: 'fixture.shiplo.site' } });
    }
    if (init?.method === 'POST' && url.pathname === '/v1/sites/site-123/deployments') {
      writeFileSync(indexPath, 'secret-replacement-content');
      return Response.json({ deployment: { id: 'dep-mutated' } }, { status: 201 });
    }
    if (init?.method === 'PUT') {
      uploadedBody = Buffer.from(await new Response(init.body).arrayBuffer()).toString('utf8');
      return Response.json({ uploaded: true });
    }
    if (url.pathname.endsWith('/finalize')) {
      return Response.json({ release: { id: 'rel-mutated' } });
    }
    if (url.pathname.endsWith('/activate')) {
      return Response.json({ deployment: { status: 'active', release_id: 'rel-mutated' } });
    }
    return Response.json({ error: { message: 'unexpected request' } }, { status: 404 });
  };

  try {
    await assert.rejects(
      deployStatic({
        siteId: 'site-123',
        cwd: project,
        outputDir: '.',
        apiToken: 'shp_test_token',
        apiBaseUrl: 'https://api.test/v1',
        fetchImpl,
      }),
      /changed after the manifest/i
    );
    assert.equal(uploadedBody, null);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('platform_deploy_static preserves structured quota error details', async () => {
  const project = mkdtempSync(join(TMP, 'quota-'));
  writeFileSync(join(project, 'index.html'), '<h1>Quota fixture</h1>');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI],
    cwd: project,
    env: {
      ...process.env,
      PLATFORM_API_BASE_URL: baseUrl,
      PLATFORM_API_TOKEN: 'shp_test_token',
      // Deployed fixtures have no real edge behind them — skip the live-URL wait.
      PLATFORM_LIVE_WAIT_TIMEOUT_MS: '0',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'quota-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'platform_deploy_static',
      arguments: { site_id: 'quota-site', output_dir: '.' },
    });

    assert.equal(result.isError, true);
    const content = result.content[0];
    assert.equal(content.type, 'text');
    assert.ok('text' in content);
    assert.deepEqual(JSON.parse(content.text), {
      error: {
        status: 400,
        code: 'FILE_SIZE_LIMIT_EXCEEDED',
        message: 'One or more files exceed the plan limit',
        details: {
          limit: 10,
          files: [{ path: 'index.html', size: 25, is_media: false }],
        },
      },
    });
  } finally {
    await client.close();
  }
});

test('upload failures include deployment and phase context', async () => {
  const project = mkdtempSync(join(TMP, 'failure-'));
  writeFileSync(join(project, 'index.html'), '<h1>Failure fixture</h1>');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI],
    cwd: project,
    env: {
      ...process.env,
      PLATFORM_API_BASE_URL: baseUrl,
      PLATFORM_API_TOKEN: 'shp_test_token',
      // Deployed fixtures have no real edge behind them — skip the live-URL wait.
      PLATFORM_LIVE_WAIT_TIMEOUT_MS: '0',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'failure-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'platform_deploy_static',
      arguments: { site_id: 'fail-site', output_dir: '.' },
    });

    assert.equal(result.isError, true);
    const content = result.content[0];
    assert.equal(content.type, 'text');
    assert.ok('text' in content);
    assert.deepEqual(JSON.parse(content.text), {
      error: {
        status: 500,
        code: 'UPLOAD_FAILED',
        message: 'Storage write failed',
        details: { retryable: true },
        deployment_id: 'dep-fail',
        phase: 'upload',
        file: 'index.html',
      },
    });
  } finally {
    await client.close();
  }
});

test('waitForLive resolves once the edge stops serving the placeholder', async () => {
  let probes = 0;
  const fetchImpl: typeof fetch = async () => {
    probes += 1;
    if (probes === 1) {
      return new Response('<html>placeholder</html>', {
        status: 404,
        headers: { 'x-shiplo-parked': '1' },
      });
    }
    return new Response('<html>real site</html>', { status: 200 });
  };

  const probe = await waitForLive('fixture.shiplo.site', fetchImpl, 5_000, 1);
  assert.equal(probe.live, true);
  assert.equal(probes, 2);
  assert.equal(probe.note, undefined);
});

test('waitForLive treats an unmarked 404 (edge predating the marker) as not live', async () => {
  const fetchImpl: typeof fetch = async () => new Response('<html>placeholder</html>', { status: 404 });

  const probe = await waitForLive('fixture.shiplo.site', fetchImpl, 30, 5);
  assert.equal(probe.live, false);
  assert.match(probe.note ?? '', /not verified live/);
});

test('waitForLive never throws on network errors and reports the last probe state', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND fixture.shiplo.site');
  };

  const probe = await waitForLive('fixture.shiplo.site', fetchImpl, 30, 5);
  assert.equal(probe.live, false);
  assert.match(probe.note ?? '', /ENOTFOUND/);
});

test('deployStatic holds the URL back until a live probe succeeds', async () => {
  const project = mkdtempSync(join(TMP, 'live-wait-'));
  mkdirSync(join(project, 'dist'));
  writeFileSync(join(project, 'dist', 'index.html'), '<h1>Live wait fixture</h1>');
  let probes = 0;

  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    if (url.host === 'fixture.shiplo.site') {
      probes += 1;
      if (probes === 1) {
        return new Response('<html>placeholder</html>', {
          status: 404,
          headers: { 'x-shiplo-parked': '1' },
        });
      }
      return new Response('<html>real site</html>', { status: 200 });
    }
    if (init?.method === undefined && url.pathname === '/v1/sites/site-123') {
      return Response.json({ site: { hostname: 'fixture.shiplo.site' } });
    }
    if (init?.method === 'POST' && url.pathname === '/v1/sites/site-123/deployments') {
      return Response.json({ deployment: { id: 'dep-live' } }, { status: 201 });
    }
    if (init?.method === 'PUT') {
      return Response.json({ uploaded: true });
    }
    if (url.pathname.endsWith('/finalize')) {
      return Response.json({ release: { id: 'rel-live' } });
    }
    if (url.pathname.endsWith('/activate')) {
      return Response.json({ deployment: { status: 'active', release_id: 'rel-live' } });
    }
    return Response.json({ error: { message: 'unexpected request' } }, { status: 404 });
  }) as typeof fetch;

  try {
    const result = await deployStatic({
      siteId: 'site-123',
      cwd: project,
      apiToken: 'shp_test_token',
      apiBaseUrl: 'https://api.test/v1',
      fetchImpl,
      liveProbeIntervalMs: 1,
    });
    assert.equal(result.live, true);
    assert.equal(probes, 2);
    assert.equal(result.url, 'https://fixture.shiplo.site');
    assert.equal(result.live_note, undefined);
    assert.ok(result.live_wait_ms >= 0);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
