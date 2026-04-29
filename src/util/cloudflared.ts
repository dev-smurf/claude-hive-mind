/**
 * Quick-tunnel helper for `chm serve --public`.
 *
 * The host machine is almost always behind NAT, so peers on the public
 * internet can't reach `http://<lan-ip>:7777`. Cloudflare's `cloudflared`
 * binary spins up an outbound tunnel and gives us a `*.trycloudflare.com`
 * URL that anyone in the world can hit. No account, no port forwarding,
 * no third-party signup — the host runs one command, the tunnel lives
 * for the lifetime of the process, then dies.
 *
 * Order of preference for finding the binary:
 *  1. `cloudflared` already on PATH (user installed via brew/apt/etc.)
 *  2. Cached binary at ~/.cache/claude-hive-mind/bin/cloudflared
 *  3. Download from cloudflare's official GitHub release into the cache.
 *
 * The download is HTTPS-only and pulls from cloudflare's own GitHub repo,
 * which is the same source `brew install cloudflared` ultimately uses.
 */

import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { logger } from './logger.js';

/**
 * Pin to a specific cloudflared release so the download URL is deterministic.
 * `latest` redirects to whatever is current at fetch time, which is unstable
 * and harder to audit. Bump this when a new release is verified safe.
 *
 * Verify a candidate version before bumping:
 *   curl -sI https://github.com/cloudflare/cloudflared/releases/download/<VER>/cloudflared-darwin-arm64.tgz
 * Should return HTTP 302 → S3, not 404. Operators who want a different
 * version can override by installing cloudflared on PATH themselves
 * (which takes precedence over our cached download).
 */
const CLOUDFLARED_VERSION = '2025.5.0';
const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

interface AssetInfo {
  /** Asset filename to fetch from `${RELEASE_BASE}/${asset}` */
  readonly asset: string;
  /** True if the asset is a tarball that needs `cloudflared` extracted */
  readonly tarball: boolean;
}

function pickAsset(): AssetInfo {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    const triple = arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64';
    return { asset: `cloudflared-${triple}.tgz`, tarball: true };
  }
  if (platform === 'linux') {
    const triple = arch === 'arm64' ? 'linux-arm64' : 'linux-amd64';
    return { asset: `cloudflared-${triple}`, tarball: false };
  }
  if (platform === 'win32') {
    return { asset: 'cloudflared-windows-amd64.exe', tarball: false };
  }
  throw new Error(`Unsupported platform for cloudflared auto-install: ${platform}/${arch}`);
}

function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  // XDG_CACHE_HOME, when set, must be an absolute path (per spec). Reject
  // relative or traversal-laden values so an attacker controlling the env
  // can't redirect the binary download outside the user's home tree.
  const useXdg =
    xdg !== undefined && xdg.length > 0 && path.isAbsolute(xdg) && !xdg.includes('..');
  const base = useXdg ? xdg : path.join(os.homedir(), '.cache');
  return path.join(base, 'claude-hive-mind', 'bin');
}

function cachedBinaryPath(): string {
  const exe = os.platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  return path.join(cacheDir(), exe);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function whichCloudflared(): string | null {
  try {
    const cmd = os.platform() === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['cloudflared'], { encoding: 'utf8' }).trim();
    const first = out.split(/\r?\n/)[0];
    return first !== undefined && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL and write it to disk. Follows redirects (Node 18+ fetch does
 * this automatically). Streams to disk so we don't buffer 40 MB in memory.
 */
async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${String(res.status)}): ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

const gunzipAsync = promisify(gunzip);

/**
 * Extract `cloudflared` from a `cloudflared-darwin-*.tgz`. Cloudflare's macOS
 * tarball contains a single file named `cloudflared` at the root. We avoid
 * pulling in a tar dependency by using a tiny POSIX-tar reader inline.
 */
async function extractCloudflaredFromTgz(tgzPath: string, destPath: string): Promise<void> {
  const gz = await readFile(tgzPath);
  const tarBuf = await gunzipAsync(gz);
  // POSIX ustar: 512-byte header per entry, name at offset 0 (100 bytes),
  // size at offset 124 (12 bytes octal).
  let off = 0;
  while (off + 512 <= tarBuf.length) {
    const nameRaw = tarBuf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');
    if (nameRaw === '') break; // end-of-archive marker
    // Path-traversal guard: never trust the entry name. We only WRITE the
    // matched entry to a fixed `destPath`, but any future refactor that
    // honours `nameRaw` for the destination would be a CVE waiting to
    // happen. Reject up front.
    if (nameRaw.includes('..') || path.isAbsolute(nameRaw) || nameRaw.includes('\0')) {
      throw new Error(`Refusing to extract suspicious tar entry: ${JSON.stringify(nameRaw)}`);
    }
    const sizeOctal = tarBuf
      .subarray(off + 124, off + 136)
      .toString('utf8')
      .replace(/\0.*$/, '')
      .trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const dataStart = off + 512;
    if (path.basename(nameRaw) === 'cloudflared') {
      const fileBuf = tarBuf.subarray(dataStart, dataStart + size);
      await writeFile(destPath, fileBuf);
      return;
    }
    // Each file's data is rounded up to the next 512-byte boundary.
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`No 'cloudflared' entry found in ${tgzPath}`);
}

/**
 * Locate `cloudflared`, downloading the official release into our cache
 * directory if it isn't already on the system. Returns the absolute path.
 */
export async function findOrInstallCloudflared(
  onProgress?: (msg: string) => void,
): Promise<string> {
  const log = (msg: string): void => {
    onProgress?.(msg);
  };

  const onPath = whichCloudflared();
  if (onPath !== null) return onPath;

  const cached = cachedBinaryPath();
  if (await pathExists(cached)) return cached;

  const { asset, tarball } = pickAsset();
  const url = `${RELEASE_BASE}/${asset}`;
  log(`cloudflared not found — downloading ${asset} from cloudflare/cloudflared...`);
  await mkdir(cacheDir(), { recursive: true });

  if (tarball) {
    const tgzPath = path.join(tmpdir(), `chm-${asset}`);
    await downloadTo(url, tgzPath);
    await extractCloudflaredFromTgz(tgzPath, cached);
    await chmod(cached, 0o755);
  } else {
    await downloadTo(url, cached);
    await chmod(cached, 0o755);
  }

  log(`cloudflared cached at ${cached}`);
  return cached;
}

export interface TunnelHandle {
  /** Public HTTPS URL (e.g. https://random-words.trycloudflare.com) */
  readonly url: string;
  readonly stop: () => void;
}

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Spawn `cloudflared tunnel --url http://localhost:<port>` and resolve once
 * we've parsed the public URL out of its log output. Throws on timeout.
 *
 * Cloudflared prints its banner to stderr; we tee both pipes to be safe.
 * The child is killed when `stop()` is called (or the parent exits).
 */
export async function startQuickTunnel(
  localPort: number,
  options: { timeoutMs?: number; onProgress?: (msg: string) => void } = {},
): Promise<TunnelHandle> {
  const { timeoutMs = 30_000, onProgress } = options;
  const bin = await findOrInstallCloudflared(onProgress);

  onProgress?.('Starting cloudflared quick tunnel...');
  const child: ChildProcess = spawn(
    bin,
    ['tunnel', '--no-autoupdate', '--url', `http://localhost:${String(localPort)}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return new Promise<TunnelHandle>((resolve, reject) => {
    let buffered = '';
    let settled = false;

    const onChunk = (chunk: Buffer): void => {
      if (settled) return;
      buffered += chunk.toString('utf8');
      const match = URL_PATTERN.exec(buffered);
      if (match) {
        settled = true;
        const url = match[0];
        child.stdout?.off('data', onChunk);
        child.stderr?.off('data', onChunk);
        resolve({
          url,
          stop: () => {
            try {
              child.kill('SIGTERM');
            } catch (err) {
              logger.warn('cloudflared', 'Failed to stop tunnel', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        });
      }
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`cloudflared did not produce a tunnel URL within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    timeout.unref();

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `cloudflared exited with code ${String(code)} before producing a URL. ` +
            `Recent output: ${buffered.slice(-400)}`,
        ),
      );
    });
  });
}
