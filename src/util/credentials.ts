/**
 * Multi-hive credentials store.
 *
 * Lives at `~/.claude-hive-mind/credentials.json`. Holds long-lived join
 * tokens for every hive this machine has been invited to. Each entry can
 * be used by `claude-hive-mind connect` (the MCP bridge) to register a
 * fresh per-session agent on that hive.
 *
 * Format:
 *   {
 *     "hives": {
 *       "<short-name>": {
 *         "url":          "http://10.0.0.147:7777",
 *         "joinToken":    "abc...",
 *         "joinTokenId":  "uuid",
 *         "label":        "Felix",
 *         "addedAt":      "2026-04-29T...",
 *         "lastUsedAt":   "2026-04-29T..."
 *       }
 *     }
 *   }
 *
 * The file is created with mode 0600 (rw-------). Fail-fast on permission
 * errors so the user notices a misconfigured machine.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const hiveEntrySchema = z.object({
  url: z.url(),
  joinToken: z.string().min(16),
  joinTokenId: z.string().min(1),
  label: z.string().nullable(),
  addedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});

const credentialsSchema = z.object({
  hives: z.record(z.string(), hiveEntrySchema),
});

export type HiveEntry = z.infer<typeof hiveEntrySchema>;
export type Credentials = z.infer<typeof credentialsSchema>;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function credentialsDir(): string {
  return process.env.CHM_CREDENTIALS_DIR ?? join(homedir(), '.claude-hive-mind');
}

export function credentialsPath(): string {
  return join(credentialsDir(), 'credentials.json');
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

const EMPTY: Credentials = { hives: {} };

export async function loadCredentials(): Promise<Credentials> {
  const path = credentialsPath();
  if (!existsSync(path)) return EMPTY;
  const raw = await readFile(path, 'utf8');
  if (raw.trim() === '') return EMPTY;
  const parsed: unknown = JSON.parse(raw);
  return credentialsSchema.parse(parsed);
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  const dir = credentialsDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const path = credentialsPath();
  await writeFile(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
  // chmod again in case the file existed with looser perms.
  await chmod(path, 0o600);
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

export interface AddHiveInput {
  readonly name: string;
  readonly url: string;
  readonly joinToken: string;
  readonly joinTokenId: string;
  readonly label?: string | null;
}

export async function addHive(input: AddHiveInput): Promise<void> {
  const creds = await loadCredentials();
  const next: Credentials = {
    hives: {
      ...creds.hives,
      [input.name]: {
        url: input.url,
        joinToken: input.joinToken,
        joinTokenId: input.joinTokenId,
        label: input.label ?? null,
        addedAt: new Date().toISOString(),
        lastUsedAt: null,
      },
    },
  };
  await saveCredentials(next);
}

export async function removeHive(name: string): Promise<boolean> {
  const creds = await loadCredentials();
  if (!(name in creds.hives)) return false;
  const { [name]: _removed, ...rest } = creds.hives;
  await saveCredentials({ hives: rest });
  return true;
}

export async function getHive(name: string): Promise<HiveEntry | undefined> {
  const creds = await loadCredentials();
  return creds.hives[name];
}

export async function listHives(): Promise<readonly { name: string; entry: HiveEntry }[]> {
  const creds = await loadCredentials();
  return Object.entries(creds.hives).map(([name, entry]) => ({ name, entry }));
}

export async function recordHiveUse(name: string): Promise<void> {
  const creds = await loadCredentials();
  const entry = creds.hives[name];
  if (!entry) return;
  await saveCredentials({
    hives: {
      ...creds.hives,
      [name]: { ...entry, lastUsedAt: new Date().toISOString() },
    },
  });
}

// ---------------------------------------------------------------------------
// chm:// URL helpers
// ---------------------------------------------------------------------------

export interface ParsedInviteUrl {
  readonly url: string;
  readonly code: string;
}

/**
 * Parse a `chm://host:port#CODE` invite URL (HTTP) or `chms://host#CODE`
 * (HTTPS — used by `chm serve --public` cloudflared tunnels). Also
 * accepts plain "host:port#CODE" or full http(s) URLs with a fragment.
 */
export function parseInviteUrl(input: string): ParsedInviteUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let normalized = trimmed;
  if (normalized.startsWith('chms://')) {
    normalized = `https://${normalized.slice('chms://'.length)}`;
  } else if (normalized.startsWith('chm://')) {
    normalized = `http://${normalized.slice('chm://'.length)}`;
  } else if (!/^https?:\/\//.test(normalized)) {
    normalized = `http://${normalized}`;
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  const code = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  if (!code) return null;

  // Strip the fragment from the URL we return.
  const baseUrl = `${url.protocol}//${url.host}`;
  return { url: baseUrl, code };
}

export function formatInviteUrl(serverUrl: string, code: string): string {
  // Replace http(s) with the chm/chms scheme and append the code as fragment.
  // `chms://` preserves the HTTPS hint so peers redeem against TLS endpoints
  // (cloudflared quick tunnels), while plain `chm://` stays HTTP-friendly
  // for LAN deployments.
  const url = new URL(serverUrl);
  const scheme = url.protocol === 'https:' ? 'chms' : 'chm';
  return `${scheme}://${url.host}#${code}`;
}
