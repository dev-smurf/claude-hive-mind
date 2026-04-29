/**
 * Path normalization for file ownership claims.
 *
 * Defends against:
 * - Null bytes (filesystem trick attempts)
 * - Absolute paths (workspace boundary escapes)
 * - Home directory expansion (`~`)
 * - Parent directory escapes (`..` after normalization)
 * - Excessively long paths
 *
 * Returns the normalized repo-relative path. Throws on invalid input.
 */

import { posix } from 'node:path';

const MAX_PATH_LENGTH = 1024;

export class InvalidPathError extends Error {
  constructor(reason: string) {
    super(`Invalid file path: ${reason}`);
    this.name = 'InvalidPathError';
  }
}

/**
 * Normalize a user-supplied file path into a safe repo-relative form.
 *
 * Rejects:
 * - Empty strings
 * - Null bytes (\0)
 * - Absolute paths (POSIX or Windows-style)
 * - Tilde expansion (`~/...`, `~user/...`)
 * - Paths that escape the workspace via `..`
 * - Paths longer than 1024 characters
 */
export function normalizeFilePath(input: string): string {
  if (typeof input !== 'string') {
    throw new InvalidPathError('not a string');
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new InvalidPathError('empty');
  }

  if (trimmed.length > MAX_PATH_LENGTH) {
    throw new InvalidPathError(`exceeds ${String(MAX_PATH_LENGTH)} characters`);
  }

  if (trimmed.includes('\0')) {
    throw new InvalidPathError('contains null byte');
  }

  // Reject percent-encoded sequences (e.g. %2e%2e for `..`). They're almost
  // never legitimate in repo-relative paths and they bypass the textual
  // traversal checks below if a downstream consumer ever URL-decodes the
  // stored path. Force callers to send the decoded form so all our checks
  // operate on the same representation.
  if (/%[0-9a-fA-F]{2}/.test(trimmed)) {
    throw new InvalidPathError(
      'percent-encoded sequences are not allowed (send the decoded path instead)',
    );
  }

  if (trimmed.startsWith('~')) {
    throw new InvalidPathError('home directory expansion not allowed');
  }

  if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new InvalidPathError('absolute paths not allowed');
  }

  // Convert any backslashes (Windows) to forward slashes for consistency.
  const forwardSlash = trimmed.replace(/\\/g, '/');

  // Reject Windows UNC paths or device paths (\\server\share, \\?\...).
  if (forwardSlash.startsWith('//')) {
    throw new InvalidPathError('UNC or network paths not allowed');
  }

  // Use posix.normalize to collapse '..' and '.' segments.
  const normalized = posix.normalize(forwardSlash);

  // After normalization, the path must not start with '..' or '/'.
  if (normalized.startsWith('..') || normalized.startsWith('/')) {
    throw new InvalidPathError('escapes workspace root');
  }

  return normalized;
}

/**
 * Try to normalize a file path. Returns null on invalid input
 * (instead of throwing). Useful at HTTP/MCP boundaries where
 * we want to return a 400 rather than a 500.
 */
export function tryNormalizeFilePath(input: string): string | null {
  try {
    return normalizeFilePath(input);
  } catch {
    return null;
  }
}
