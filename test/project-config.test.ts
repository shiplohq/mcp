import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as projectConfig from '../src/project-config';

test('inspection detects a Next static export before the output directory exists', async () => {
  const project = mkdtempSync(join(tmpdir(), 'shiplo-next-export-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({
      name: '@example/marketing-site',
      scripts: { build: 'next build' },
      dependencies: { next: '^15.0.0' },
    }));
    writeFileSync(join(project, 'next.config.mjs'), "export default { output: 'export' };\n");

    assert.deepEqual(await projectConfig.inspectProject(project), {
      project_name: 'marketing-site',
      preferred_subdomain: 'marketing-site',
      build_command: 'npm run build',
      output_dir: 'out',
      missing_fields: [],
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('plain static inspection uses the repository root without a build', async () => {
  const project = mkdtempSync(join(tmpdir(), 'shiplo-plain-static-'));
  try {
    writeFileSync(join(project, 'index.html'), '<h1>Plain static</h1>');
    const result = await projectConfig.inspectProject(project);
    assert.equal(result.project_name, project.split(/[/\\]/).at(-1));
    assert.equal(result.build_command, null);
    assert.equal(result.output_dir, '.');
    assert.deepEqual(result.missing_fields, []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('inspection reports ambiguous projects instead of guessing deploy settings', async () => {
  const project = mkdtempSync(join(tmpdir(), 'shiplo-ambiguous-'));
  try {
    const result = await projectConfig.inspectProject(project);
    assert.equal(result.build_command, null);
    assert.equal(result.output_dir, null);
    assert.deepEqual(result.missing_fields, ['output_dir']);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('project config is written atomically and can be read back', async () => {
  const project = mkdtempSync(join(tmpdir(), 'shiplo-project-config-'));
  const config = {
    version: 1 as const,
    project_name: 'Atomic fixture',
    site_id: 'site-atomic',
    subdomain: 'atomic-fixture',
    build_command: 'npm run build',
    output_dir: 'dist',
  };
  try {
    await projectConfig.writeProjectConfig(project, config);
    assert.equal(typeof projectConfig.readProjectConfig, 'function');
    assert.deepEqual(await projectConfig.readProjectConfig(project), config);
    assert.deepEqual(
      JSON.parse(readFileSync(join(project, '.shiplo', 'project.json'), 'utf8')),
      config
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('newer project config versions fail without overwriting the file', async () => {
  const project = mkdtempSync(join(tmpdir(), 'shiplo-project-newer-'));
  const configPath = join(project, '.shiplo', 'project.json');
  mkdirSync(join(project, '.shiplo'));
  writeFileSync(configPath, JSON.stringify({
    version: 99,
    project_name: 'Future fixture',
    site_id: 'site-future',
    subdomain: 'future-fixture',
    build_command: null,
    output_dir: '.',
  }));
  try {
    assert.equal(typeof projectConfig.readProjectConfig, 'function');
    await assert.rejects(
      projectConfig.readProjectConfig(project),
      /newer.*upgrade|upgrade.*newer/i
    );
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).version, 99);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('project config refuses a .shiplo symlink that escapes the project', async () => {
  const project = mkdtempSync(join(tmpdir(), 'shiplo-config-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'shiplo-config-outside-'));
  symlinkSync(outside, join(project, '.shiplo'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(
      projectConfig.writeProjectConfig(project, {
        version: 1,
        project_name: 'Escape fixture',
        site_id: 'site-escape',
        subdomain: 'escape-fixture',
        build_command: null,
        output_dir: '.',
      }),
      /symbolic link|symlink/i
    );
    assert.equal(existsSync(join(outside, 'project.json')), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
