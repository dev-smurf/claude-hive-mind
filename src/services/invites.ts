/**
 * Invite & join-token service.
 *
 * Two-tier onboarding:
 *  1. Host (or any agent) creates an INVITE — a short, single-use, time-limited
 *     code (e.g. "A4F2-9E7K") that the new peer types into the join CLI.
 *  2. The join CLI redeems the invite and gets a JOIN TOKEN — a long-lived
 *     bearer credential stored on the joining machine.
 *  3. Each Claude/Codex session that opts into the hive uses the join token to
 *     register a fresh per-session agent identity.
 *
 * Security model:
 *  - Invite codes have low entropy by design (humans copy them) — they're
 *    rate-limited HARD at the redeem endpoint and expire fast.
 *  - Join tokens are 256-bit random hex; only the SHA-256 hash is stored.
 *  - Join tokens are revocable individually by the host.
 *  - A peer-issued invite consumes the issuer's quota (max 5 outstanding).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isoTimestamp } from '../schemas.js';
import type { InviteRow, JoinTokenRow, Store } from './store.js';
import { logger } from '../util/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default invite TTL (10 minutes). */
const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;
/** Max simultaneously-outstanding invites issued by a single agent. */
const MAX_OUTSTANDING_INVITES_PER_AGENT = 5;
/** Alphabet excludes 0/O/1/I/L to reduce dictation errors. */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateInviteInput {
  /** 'admin' or an agent UUID. */
  readonly createdBy: string;
  /** Optional human-readable label ("Felix's machine"). */
  readonly label?: string;
  /** TTL in milliseconds (default 10 min). */
  readonly ttlMs?: number;
  /**
   * How many times the invite can be redeemed (default 1 = single-use,
   * preserving prior security posture). `chm start` mints with a higher
   * value so the host can share one URL with multiple teammates.
   */
  readonly maxUses?: number;
}

export interface CreateInviteResult {
  readonly code: string;
  readonly expiresAt: string;
  readonly label: string | null;
  readonly maxUses: number;
}

export interface RedeemInput {
  readonly code: string;
  readonly remoteIp: string;
}

export interface RedeemResult {
  /** Long-lived join token returned to the joining machine. */
  readonly joinToken: string;
  /** Short ID for revocation. */
  readonly joinTokenId: string;
  readonly label: string | null;
}

export interface InviteListEntry {
  readonly code: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumed: boolean;
  readonly label: string | null;
}

export interface JoinTokenListEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly label: string | null;
  readonly inviteCode: string | null;
  readonly agentCount: number;
  readonly lastUsedAt: string | null;
  readonly revoked: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate an 8-char invite code formatted as "AAAA-AAAA". */
function generateInviteCode(): string {
  const buf = randomBytes(8);
  const chars: string[] = [];
  for (const b of buf) {
    const ch = INVITE_ALPHABET[b % INVITE_ALPHABET.length] ?? 'A';
    chars.push(ch);
  }
  const code = chars.join('');
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

/** Generate a 256-bit join token in hex. */
function generateJoinToken(): string {
  return randomBytes(32).toString('hex');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Normalize an invite code: uppercase, strip spaces and dashes. */
export function normalizeInviteCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[\s-]/g, '');
  if (cleaned.length !== 8) return '';
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class InviteService {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * Create a new invite. Validates the issuer's quota for non-admin creators.
   * Throws on quota exceeded; caller should turn that into HTTP 429/409.
   */
  create(input: CreateInviteInput): CreateInviteResult {
    const now = isoTimestamp();
    const ttl = input.ttlMs ?? DEFAULT_INVITE_TTL_MS;
    const expires = isoTimestamp(new Date(Date.now() + ttl));

    if (input.createdBy !== 'admin') {
      const outstanding = this.store.countOutstandingInvitesBy(input.createdBy, now);
      if (outstanding >= MAX_OUTSTANDING_INVITES_PER_AGENT) {
        throw new InviteQuotaExceededError(MAX_OUTSTANDING_INVITES_PER_AGENT);
      }
    }

    // Generate codes until we get one that doesn't collide with a live invite.
    // Collisions are astronomically unlikely (8 chars * 31 alphabet = ~10^11)
    // but the loop is cheap insurance.
    let code = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      code = generateInviteCode();
      const existing = this.store.getRedeemableInvite(code, now);
      if (!existing) break;
    }
    if (!code) {
      throw new Error('Failed to generate unique invite code');
    }

    const maxUses = Math.max(1, Math.floor(input.maxUses ?? 1));
    const row: InviteRow = {
      code,
      created_by: input.createdBy,
      created_at: now,
      expires_at: expires,
      consumed_at: null,
      consumed_by: null,
      consumed_ip: null,
      label: input.label ?? null,
      max_uses: maxUses,
      use_count: 0,
    };
    this.store.insertInvite(row);

    return { code, expiresAt: expires, label: row.label, maxUses };
  }

  /**
   * Redeem an invite code. Atomic: the invite is consumed and a fresh join
   * token is minted in a single transaction. Returns the join token (only
   * the hash is stored — the raw token is shown to the redeemer once).
   */
  redeem(input: RedeemInput): RedeemResult {
    return this.store.transaction(() => {
      const now = isoTimestamp();
      const invite = this.store.getRedeemableInvite(input.code, now);
      if (!invite) {
        throw new InviteNotRedeemableError();
      }

      const joinToken = generateJoinToken();
      const joinTokenId = randomUUID();
      const tokenHash = sha256Hex(joinToken);

      const row: JoinTokenRow = {
        id: joinTokenId,
        token_hash: tokenHash,
        created_at: now,
        invite_code: invite.code,
        label: invite.label,
        last_used_at: null,
        agent_count: 0,
        revoked: 0,
      };
      this.store.insertJoinToken(row);
      this.store.markInviteUsed(invite.code, joinTokenId, input.remoteIp, now);

      logger.info('invites', 'Invite redeemed', {
        code: invite.code,
        joinTokenId,
        ip: input.remoteIp,
        label: invite.label,
      });

      return { joinToken, joinTokenId, label: invite.label };
    });
  }

  /**
   * Validate a join token presented as a Bearer credential. Returns the
   * matching join_token row (with stripped hash) or undefined.
   */
  validateJoinToken(token: string): JoinTokenListEntry | undefined {
    if (!token) return undefined;
    const row = this.store.getJoinTokenByHash(sha256Hex(token));
    if (!row) return undefined;
    if (row.revoked) return undefined;
    return rowToJoinTokenListEntry(row);
  }

  /** Update last_used_at + increment agent_count. Called on register. */
  recordJoinTokenUse(id: string): void {
    this.store.recordJoinTokenUse(id, isoTimestamp());
  }

  /**
   * List invites visible to the caller. Admin sees all; an agent sees only
   * the ones they created.
   */
  list(callerScope: string): readonly InviteListEntry[] {
    const rows =
      callerScope === 'admin' ? this.store.getAllInvites() : this.store.getAllInvites(callerScope);
    return rows.map(rowToInviteListEntry);
  }

  /** Revoke an invite. Admin can revoke any; an agent can revoke its own. */
  revoke(code: string, callerScope: string): boolean {
    if (callerScope !== 'admin') {
      const list = this.store.getAllInvites(callerScope);
      if (!list.some((i) => i.code === code)) return false;
    }
    return this.store.deleteInvite(code);
  }

  /** Revoke a join token by ID. */
  revokeJoinToken(id: string): boolean {
    return this.store.revokeJoinToken(id);
  }

  listJoinTokens(): readonly JoinTokenListEntry[] {
    return this.store.getAllJoinTokens().map(rowToJoinTokenListEntry);
  }

  /** Periodic maintenance: drop expired-but-unconsumed invites. */
  cleanupExpired(): number {
    return this.store.deleteExpiredInvites(isoTimestamp());
  }
}

// ---------------------------------------------------------------------------
// Row converters
// ---------------------------------------------------------------------------

function rowToInviteListEntry(row: InviteRow): InviteListEntry {
  return {
    code: row.code,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumed: row.consumed_at !== null,
    label: row.label,
  };
}

function rowToJoinTokenListEntry(row: JoinTokenRow): JoinTokenListEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    label: row.label,
    inviteCode: row.invite_code,
    agentCount: row.agent_count,
    lastUsedAt: row.last_used_at,
    revoked: row.revoked === 1,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InviteNotRedeemableError extends Error {
  constructor() {
    super('Invite code is invalid, expired, or already used');
    this.name = 'InviteNotRedeemableError';
  }
}

export class InviteQuotaExceededError extends Error {
  constructor(limit: number) {
    super(`You already have ${String(limit)} outstanding invites — revoke one first`);
    this.name = 'InviteQuotaExceededError';
  }
}
