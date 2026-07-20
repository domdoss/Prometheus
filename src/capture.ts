import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  screenshot as dcScreenshot,
  windowList,
  windowFocus,
  type Region,
} from './desktop-control.js';

const pexecFile = promisify(execFile);

// Cap the longest edge so a full 4K screenshot doesn't blow up the vision
// context. Text stays legible at this width.
const MAX_DIMENSION = 1600;

export interface CapturedImage {
  /** base64-encoded image bytes (no data: prefix) */
  image: string;
  /** MIME type, e.g. image/png | image/jpeg */
  mediaType: string;
  width: number;
  height: number;
}

async function toPngCaptured(buf: Buffer): Promise<CapturedImage> {
  const meta = await sharp(buf).metadata();
  let img = sharp(buf, { animated: false });
  if ((meta.width ?? 0) > MAX_DIMENSION || (meta.height ?? 0) > MAX_DIMENSION) {
    img = img.resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  const out = await img.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
  return {
    image: out.data.toString('base64'),
    mediaType: 'image/png',
    width: out.info.width,
    height: out.info.height,
  };
}

async function toJpegCaptured(buf: Buffer, quality = 85): Promise<CapturedImage> {
  const out = await sharp(buf)
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });
  return {
    image: out.data.toString('base64'),
    mediaType: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
  };
}

/**
 * Capture a screenshot on the host desktop. If `windowTitle` is given, the
 * matching window is focused first (best-effort). `region` crops to a
 * sub-rectangle in pixels. Returns a PNG (text stays sharp) sized to <=1600px.
 */
export async function captureScreenshot(opts?: {
  windowTitle?: string;
  region?: Region;
}): Promise<CapturedImage> {
  if (opts?.windowTitle) {
    try {
      const wins = await windowList();
      const needle = opts.windowTitle.toLowerCase();
      const hit = wins.find((w) => w.title.toLowerCase().includes(needle));
      if (hit) await windowFocus(hit.id);
    } catch {
      /* best-effort focus — capture anyway */
    }
  }
  const buf = await dcScreenshot(opts?.region);
  if (!buf || buf.length === 0) {
    throw new Error('screenshot returned an empty buffer (is the host display reachable?)');
  }
  return toPngCaptured(buf);
}

/**
 * Grab a single frame from a V4L2 webcam on the host. Tries MJPEG first (what
 * most webcams deliver at decent resolutions), then falls back to the default
 * input format. Returns a JPEG.
 */
export async function captureWebcam(opts?: {
  device?: string;
  width?: number;
}): Promise<CapturedImage> {
  const device = opts?.device && opts.device.trim() ? opts.device.trim() : '/dev/video0';
  const targetWidth =
    opts?.width && opts.width > 0 ? Math.min(Math.round(opts.width), 1280) : 640;
  const height = Math.round((targetWidth * 3) / 4);

  const baseArgs = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'v4l2',
    '-video_size',
    `${targetWidth}x${height}`,
    '-i',
    device,
    '-frames:v',
    '1',
    '-f',
    'image2',
    '-',
  ];

  let stdout: Buffer | null = null;
  let lastErr: unknown = null;
  for (const inputFormat of ['mjpeg', null] as const) {
    try {
      const args = inputFormat
        ? ['-input_format', inputFormat, ...baseArgs]
        : baseArgs;
      const res = await pexecFile('ffmpeg', args, {
        encoding: 'buffer',
        timeout: 15000,
      });
      stdout = (res.stdout as unknown as Buffer) ?? null;
      if (stdout && stdout.length > 0) break;
    } catch (err: any) {
      lastErr = err;
    }
  }

  if (!stdout || stdout.length === 0) {
    throw new Error(
      `webcam capture from ${device} returned no data (is the device present, not in use, and ffmpeg installed?${
        lastErr ? ` Last error: ${String((lastErr as any)?.message ?? lastErr)}` : ''
      })`,
    );
  }
  return toJpegCaptured(stdout);
}

/**
 * URL of the Security Mode app's frame server (set by WARDEN_SECURITY_FRAME_URL,
 * default http://127.0.0.1:8765/frame). When the security app is running it owns
 * /dev/video0, so webcam_capture pulls the latest frame from here instead of
 * fighting for the device. The security app publishes a JPEG on every capture.
 */
const SECURITY_FRAME_URL: string =
  process.env.WARDEN_SECURITY_FRAME_URL || 'http://127.0.0.1:8765/frame';

/**
 * Fetch the latest frame from the Security Mode app's HTTP /frame endpoint and
 * return it as a JPEG CapturedImage. Throws on any failure so the caller can
 * fall back to the ffmpeg path.
 */
export async function captureWebcamFromSecurityApp(): Promise<CapturedImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(SECURITY_FRAME_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`frame server returned ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf || buf.length === 0) throw new Error('frame server returned empty body');
    return toJpegCaptured(buf);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True if a Security Mode frame server appears to be running (cheap HEAD/GET
 * probe, 1s timeout). Used to decide whether to route webcam_capture through
 * the security app or grab /dev/video0 directly.
 */
export async function securityAppHasFrameServer(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const res = await fetch(SECURITY_FRAME_URL, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Read an arbitrary image file from the host filesystem into vision context.
 * Lets the agent see images that live outside the container workspace.
 * Format is preserved (PNG kept as PNG, everything else JPEG).
 */
export async function readHostImage(filePath: string): Promise<CapturedImage> {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('missing path');
  }
  const buf = fs.readFileSync(filePath);
  if (!buf || buf.length === 0) {
    throw new Error(`image file is empty: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png' || ext === '.gif') {
    return toPngCaptured(buf);
  }
  return toJpegCaptured(buf);
}