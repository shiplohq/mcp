// Agent-side media optimizer for the deploy flow. Images re-encode through
// bundled sharp (no system dependencies). Video needs an ffmpeg binary:
// resolved from ffmpeg-static (present in the full MCP build) or from PATH;
// when neither exists the caller offers skip as the only option.
import { execFile, execFileSync } from 'child_process';
import { existsSync, promises as fs, renameSync, statSync, unlinkSync } from 'fs';
import { basename, dirname, extname, join } from 'path';
import sharp from 'sharp';

export interface OptimizeResult {
  ok: boolean;
  kind: 'image' | 'video';
  /** Final path of the optimized file (may change extension, e.g. .avi → .mp4). */
  path: string;
  original_bytes: number;
  optimized_bytes: number | null;
  error?: string;
}

/** Container extensions routed to the ffmpeg path. */
export const VIDEO_EXTENSIONS: readonly string[] = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'];

interface ImageAttempt {
  width: number;
  quality?: number;
}

const PNG_LADDER: ImageAttempt[] = [
  { width: 2000, quality: 80 },
  { width: 1600, quality: 70 },
  { width: 1280, quality: 60 },
  { width: 1024, quality: 50 },
  { width: 800, quality: 40 },
  { width: 640, quality: 30 },
];

const JPEG_LADDER: ImageAttempt[] = [
  { width: 2400, quality: 85 },
  { width: 2000, quality: 75 },
  { width: 1600, quality: 65 },
  { width: 1280, quality: 55 },
  { width: 1024, quality: 45 },
  { width: 800, quality: 35 },
];

const WEBP_LADDER: ImageAttempt[] = [
  { width: 2400, quality: 85 },
  { width: 2000, quality: 75 },
  { width: 1600, quality: 65 },
  { width: 1280, quality: 55 },
  { width: 1024, quality: 45 },
  { width: 800, quality: 35 },
];

const AVIF_LADDER: ImageAttempt[] = [
  { width: 2400, quality: 50 },
  { width: 2000, quality: 45 },
  { width: 1600, quality: 40 },
  { width: 1280, quality: 35 },
  { width: 1024, quality: 30 },
];

const GIF_LADDER: ImageAttempt[] = [
  { width: 1600 },
  { width: 1280 },
  { width: 1024 },
  { width: 800 },
  { width: 640 },
];

/** Formats sharp cannot re-encode usefully — callers should offer skip. */
const UNSUPPORTED_IMAGE = new Set(['.svg', '.ico', '.bmp']);

let ffmpegCache: string | null | undefined;

/**
 * Locate an ffmpeg binary: ffmpeg-static (full MCP build) first, then PATH.
 * Cached; returns null when video re-encoding is unavailable.
 */
export function findFfmpeg(): string | null {
  if (ffmpegCache !== undefined) {
    return ffmpegCache;
  }
  ffmpegCache = null;
  try {
    // Dynamic require: ffmpeg-static is only installed in the full build.
    const staticPath = require('ffmpeg-static') as string | { default?: string } | undefined;
    const resolved = typeof staticPath === 'string' ? staticPath : staticPath?.default;
    if (resolved && existsSync(resolved)) {
      ffmpegCache = resolved;
      return ffmpegCache;
    }
  } catch {
    /* not installed — light build */
  }
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10_000 });
    ffmpegCache = 'ffmpeg';
  } catch {
    /* no system ffmpeg */
  }
  return ffmpegCache;
}

function encodeImage(buffer: sharp.Sharp, ext: string, attempt: ImageAttempt) {
  const resized = buffer.resize({ width: attempt.width, withoutEnlargement: true });
  switch (ext) {
    case '.png':
      return resized.png({ palette: true, quality: attempt.quality, compressionLevel: 9 });
    case '.jpg':
    case '.jpeg':
      return resized.rotate().jpeg({ quality: attempt.quality, mozjpeg: true });
    case '.webp':
      return resized.webp({ quality: attempt.quality });
    case '.avif':
      return resized.avif({ quality: attempt.quality });
    case '.gif':
      return resized.gif();
    default:
      throw new Error(`unsupported image extension: ${ext}`);
  }
}

function ladderFor(ext: string): ImageAttempt[] | null {
  switch (ext) {
    case '.png':
      return PNG_LADDER;
    case '.jpg':
    case '.jpeg':
      return JPEG_LADDER;
    case '.webp':
      return WEBP_LADDER;
    case '.avif':
      return AVIF_LADDER;
    case '.gif':
      return GIF_LADDER;
    default:
      return null;
  }
}

/**
 * Shrink an image file in place until it fits under maxBytes, walking a
 * resize/quality ladder. Never enlarges; the original is only replaced after
 * an attempt succeeds.
 */
export async function optimizeImage(filePath: string, maxBytes: number): Promise<OptimizeResult> {
  const ext = extname(filePath).toLowerCase();
  const original = statSync(filePath).size;
  const base: OptimizeResult = { ok: false, kind: 'image', path: filePath, original_bytes: original, optimized_bytes: null };

  if (original <= maxBytes) {
    return { ...base, ok: true, optimized_bytes: original };
  }
  if (UNSUPPORTED_IMAGE.has(ext)) {
    return { ...base, error: `cannot re-encode ${ext} — offer the user skip` };
  }
  const ladder = ladderFor(ext);
  if (!ladder) {
    return { ...base, error: `unsupported image extension: ${ext}` };
  }

  try {
    for (const attempt of ladder) {
      const buffer = await encodeImage(sharp(filePath), ext, attempt).toBuffer();
      if (buffer.length <= maxBytes) {
        const tmp = `${filePath}.__optimizing${ext}`;
        await fs.writeFile(tmp, buffer);
        renameSync(tmp, filePath);
        return { ...base, ok: true, optimized_bytes: buffer.length };
      }
    }
  } catch (error) {
    return { ...base, error: `image optimization failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ...base, error: 'could not reach the size cap even at the smallest setting — offer the user skip' };
}

interface VideoAttempt {
  scale: number;
  crf: string;
  audioBitrate: string | null;
}

const VIDEO_LADDER: VideoAttempt[] = [
  { scale: 720, crf: '28', audioBitrate: '96k' },
  { scale: 480, crf: '30', audioBitrate: '64k' },
  { scale: 360, crf: '32', audioBitrate: '48k' },
  { scale: 360, crf: '34', audioBitrate: null }, // last resort: drop audio
];

function runFfmpeg(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function videoArgs(
  input: string,
  output: string,
  targetExt: string,
  attempt: VideoAttempt
): string[] {
  const args = ['-i', input, '-vf', `scale=-2:${attempt.scale}`];
  if (targetExt === '.webm') {
    args.push('-c:v', 'libvpx-vp9', '-crf', attempt.crf, '-b:v', '0', '-row-mt', '1');
  } else {
    args.push('-c:v', 'libx264', '-crf', attempt.crf, '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  }
  if (attempt.audioBitrate) {
    if (targetExt === '.webm') {
      args.push('-c:a', 'libopus', '-b:a', attempt.audioBitrate);
    } else {
      args.push('-c:a', 'aac', '-b:a', attempt.audioBitrate);
    }
  } else {
    args.push('-an');
  }
  if (targetExt === '.mp4') {
    args.push('-movflags', '+faststart');
  }
  args.push('-y', output);
  return args;
}

/**
 * Re-encode a video until it fits under maxBytes (720p → 480p → 360p, audio
 * dropped as a last resort). Non-mp4/webm containers are normalized to .mp4
 * and the original file removed — the returned path is authoritative.
 */
export async function optimizeVideo(filePath: string, maxBytes: number): Promise<OptimizeResult> {
  const ext = extname(filePath).toLowerCase();
  const original = statSync(filePath).size;
  const base: OptimizeResult = { ok: false, kind: 'video', path: filePath, original_bytes: original, optimized_bytes: null };

  if (original <= maxBytes) {
    return { ...base, ok: true, optimized_bytes: original };
  }

  const binary = findFfmpeg();
  if (!binary) {
    return {
      ...base,
      error: 'no ffmpeg available — install the full MCP (platform-mcp-full) or offer the user skip',
    };
  }

  const targetExt = ext === '.webm' ? '.webm' : '.mp4';
  const finalPath = join(dirname(filePath), basename(filePath, ext) + (ext === targetExt ? targetExt : '.mp4'));
  const tmp = `${filePath}.__optimizing${targetExt}`;

  try {
    for (const attempt of VIDEO_LADDER) {
      await runFfmpeg(binary, videoArgs(filePath, tmp, targetExt, attempt), 300_000);
      const size = existsSync(tmp) ? statSync(tmp).size : 0;
      if (size > 0 && size <= maxBytes) {
        if (finalPath !== filePath) {
          await fs.unlink(filePath);
        }
        renameSync(tmp, finalPath);
        return { ...base, ok: true, path: finalPath, optimized_bytes: size };
      }
    }
  } catch (error) {
    return { ...base, error: `video re-encode failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (existsSync(tmp)) {
      unlinkSync(tmp);
    }
  }
  return { ...base, error: 'could not reach the size cap even at the smallest setting — offer the user skip' };
}
