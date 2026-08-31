import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { deployStatic } from '../src/deploy';

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
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'deploy-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const buildCommand = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('.env.build-token', process.env.PLATFORM_API_TOKEN || '')"`;
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
    });
  } finally {
    await client.close();
  }

  assert.equal(readFileSync(join(project, '.env.build-token'), 'utf8'), '');

  assert.deepEqual(
    requests.map(({ method, url }) => `${method} ${url}`),
    [
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
  assert.deepEqual(JSON.parse(requests[1].body.toString('utf8')), { manifest });
  assert.deepEqual(JSON.parse(requests[4].body.toString('utf8')), { manifest });
  assert.equal(requests[2].contentType, 'application/octet-stream');
  assert.deepEqual(requests[2].body, files.get('assets/app.js'));
  assert.deepEqual(requests[3].body, files.get('index.html'));
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
