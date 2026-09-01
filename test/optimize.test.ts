// Agent-side media optimizer: images via bundled sharp; video via ffmpeg
// (ffmpeg-static in the full MCP build, or any ffmpeg found on PATH).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { optimizeImage, optimizeVideo, findFfmpeg, isAbsoluteMediaPath } from '../src/optimize';

const TMP = mkdtempSync(join(tmpdir(), 'shiplo-mcp-opt-'));
const MB = 1024 * 1024;

test('media path validation accepts the native absolute-path format', () => {
  assert.equal(isAbsoluteMediaPath(join(TMP, 'native.png')), true);
  assert.equal(isAbsoluteMediaPath('relative/native.png'), false);
});

after(async () => {
  rmSync(TMP, { recursive: true, force: true });
});

test('optimizeImage shrinks an oversized PNG under the cap in place', async () => {
  const file = join(TMP, 'hero.png');
  // Gaussian noise keeps PNG compression from winning — guaranteed multi-MB.
  await sharp({ create: { width: 2400, height: 2400, channels: 3, noise: { type: 'gaussian' } } })
    .png()
    .toFile(file);
  const before = statSync(file).size;
  assert.ok(before > 3 * MB, `fixture must exceed 3MB (got ${before})`);

  const result = await optimizeImage(file, 3 * MB);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.path, file);
  assert.ok(result.optimized_bytes! <= 3 * MB, `got ${result.optimized_bytes}`);
  assert.ok(result.optimized_bytes! < before);
  const meta = await sharp(file).metadata();
  assert.equal(meta.format, 'png');
});

test('optimizeImage leaves an already-small image untouched', async () => {
  const file = join(TMP, 'small.png');
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0a9b51' } }).png().toFile(file);
  const result = await optimizeImage(file, 3 * MB);
  assert.equal(result.ok, true);
  assert.equal(result.optimized_bytes, statSync(file).size);
});

test('optimizeImage reports a typed error for formats it cannot re-encode', async () => {
  const file = join(TMP, 'icon.ico');
  // Minimal .ico header blob — sharp cannot re-encode ico; must fail cleanly.
  const header = Buffer.alloc(64);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  await import('node:fs').then((fs) => fs.promises.writeFile(file, header));
  // Cap below the 64-byte fixture so the unsupported-format path is reached.
  const result = await optimizeImage(file, 10);
  assert.equal(result.ok, false);
  assert.ok(result.error, 'an error message is required');
});

test('findFfmpeg resolves to a binary path or null without throwing', () => {
  const found = findFfmpeg();
  assert.ok(found === null || typeof found === 'string');
});

test('optimizeVideo re-encodes under the cap when ffmpeg is available', async (t) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    t.skip('no ffmpeg available (light build without system ffmpeg)');
    return;
  }
  const file = join(TMP, 'clip.mp4');
  const { execFileSync } = await import('node:child_process');
  execFileSync(ffmpeg, [
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-y', file,
  ]);
  const before = statSync(file).size;
  assert.ok(before > 120 * 1024, `fixture must exceed the 120KB test cap (got ${before})`);

  const result = await optimizeVideo(file, 120 * 1024);
  assert.equal(result.ok, true, result.error);
  assert.ok(result.optimized_bytes! <= 120 * 1024, `got ${result.optimized_bytes}`);
  assert.ok(result.optimized_bytes! < before);
});
