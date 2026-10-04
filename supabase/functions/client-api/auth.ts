// ---------------------------------------------------------------------------
// Authentication and the workspace gate.
//
// 1. WHO. The browser sends its Supabase access token as a bearer. It is
//    verified LOCALLY: no network round trip on a warm request.
//      - asymmetric projects (ES256 / RS256): against the project JWKS at
//        {SUPABASE_URL}/auth/v1/.well-known/jwks.json, cached in the isolate;
//      - legacy projects (HS256): against SUPABASE_JWT_SECRET / JWT_SECRET;
//      - if neither is possible (HS256 token, no secret configured): one call
//        to GoTrue's /auth/v1/user, cached per token for at most 60 s.
//    `alg: none`, an unknown alg, a bad signature, a wrong `aud`, an expired
//    token and a non-user role (anon / service_role keys are JWTs too) are all
//    refused with the same 401.
//
//    Known limit of local verification, stated rather than hidden: a session
//    revoked server-side (sign-out everywhere, password change) keeps working
//    here until the access token's own `exp`, at most the project's JWT expiry
//    (1 hour by default). That is the standard trade for not asking GoTrue on
//    every request.
//
// 2. WHERE. Workspace = `X-Workspace-Id` when given (must be one the user is a
//    member of), else the user's earliest membership that has the web client
//    enabled, else their earliest membership.
//
// 3. WHETHER. `workspaces.web_client_enabled` must be true for EVERY route.
//    A viewer may only run read operations (enforced per op in mail/ops.ts).
//
// Memberships are cached per user for <= 60 s, so a warm request costs zero
// database queries here. The cost of that cache is the same 60 s for a removed
// member or a switched-off workspace to take effect in this isolate.
// ---------------------------------------------------------------------------

import { ApiError, forbidden, unauthenticated } from "./errors.ts";
import type { ApiKeyRow, InboxRow } from "./seam.ts";

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface Membership {
  workspace_id: string;
  role: WorkspaceRole;
  joined_at: string;
  display_name: string;
  plan: string;
  web_client_enabled: boolean;
  /**
   * Loaded in the SAME round trip as the membership when the store can do it
   * (store.ts `memberships`): the workspace's hidden key row and its inbox
   * rows, so a cold isolate reaches its handler after one query instead of
   * three. Server-side only: `/session` builds its workspace list field by
   * field and never spreads this object.
   */
  web_client_key?: ApiKeyRow | null;
  inbox_rows?: InboxRow[];
}

export interface AuthedUser {
  id: string;
  email: string;
}

export interface AuthContext {
  user: AuthedUser;
  memberships: Membership[];
  workspace: Membership;
}

export interface JwtClaims {
  sub: string;
  email?: string;
  exp: number;
  aud?: string | string[];
  role?: string;
  iss?: string;
  nbf?: number;
}

type Jwk = JsonWebKey & { kid?: string; alg?: string };

export interface JwtVerifierConfig {
  supabaseUrl: string;
  /** HS256 secret, when the project still signs with one. */
  jwtSecret?: string;
  /** apikey for the GoTrue fallback. */
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Seconds of clock skew tolerated on `exp` / `nbf`. */
  leewaySec?: number;
  jwksTtlMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPECTED_AUD = "authenticated";

function b64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export class JwtVerifier {
  readonly #cfg: JwtVerifierConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #hsKey: Promise<CryptoKey> | null = null;
  #jwks: { keys: Map<string, Promise<CryptoKey>>; at: number } | null = null;
  #jwksLoading: Promise<void> | null = null;
  #jwksLastMissAt = 0;
  readonly #remote = new Map<string, { claims: JwtClaims; until: number }>();
  /**
   * Tokens whose SIGNATURE this isolate has already checked, by the token text
   * itself. A socket presents the same token on every frame, and the ECDSA
   * verify plus two base64 + JSON decodes were the largest fixed cost of a
   * frame. A hit skips only that: `exp`, `nbf`, `aud`, `role` and `sub` are
   * re-checked against the clock on every call, so an expired token is refused
   * exactly when it was before. Emptied whenever the signing keys are
   * reloaded, so a key removed from the JWKS stops vouching within the JWKS
   * TTL as it always did. Tokens checked by GoTrue are not kept here: that
   * path has its own 60 s cache.
   */
  readonly #verified = new Map<string, JwtClaims>();

  constructor(cfg: JwtVerifierConfig) {
    this.#cfg = cfg;
    this.#fetch = cfg.fetch ?? ((input, init) => fetch(input, init));
    this.#now = cfg.now ?? (() => Date.now());
  }

  /**
   * The `sub` an UNVERIFIED token claims, but only when verifying it is about
   * to cost a network round trip (the JWKS is not loaded yet: a cold isolate),
   * and only for a token that at least looks like one of ours. The caller may
   * start loading that user's memberships while the keys are fetched. Nothing
   * loaded that way is used unless `verify` then succeeds for the same `sub`.
   * Returns null whenever verification is local, so a warm isolate never
   * touches the database for a token it has not verified.
   */
  speculativeSubject(token: string): string | null {
    const ttl = this.#cfg.jwksTtlMs ?? 10 * 60_000;
    if (this.#jwks && this.#now() - this.#jwks.at < ttl) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const header = parseJson(b64urlToBytes(parts[0]));
      const payload = parseJson(b64urlToBytes(parts[1]));
      if (!header || !payload) return null;
      if (header["alg"] !== "ES256" && header["alg"] !== "RS256") return null;
      this.#checkClaims(payload as unknown as JwtClaims);
      return String(payload["sub"]).toLowerCase();
    } catch {
      return null;
    }
  }

  /** Verified claims, or throws the 401. Never says why on the wire. */
  async verify(token: string): Promise<JwtClaims> {
    const known = this.#verified.get(token);
    if (known) {
      try {
        this.#checkClaims(known);
      } catch (error) {
        this.#verified.delete(token);
        throw error;
      }
      return known;
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw unauthenticated();
    let header: Record<string, unknown> | null;
    let payload: Record<string, unknown> | null;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      header = parseJson(b64urlToBytes(parts[0]));
      payload = parseJson(b64urlToBytes(parts[1]));
      signature = b64urlToBytes(parts[2]);
    } catch {
      throw unauthenticated();
    }
    if (!header || !payload) throw unauthenticated();
    const alg = typeof header["alg"] === "string" ? header["alg"] : "";
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

    let claims: JwtClaims;
    let local = true;
    if (alg === "HS256") {
      if (this.#cfg.jwtSecret) {
        const key = await this.#hmacKey(this.#cfg.jwtSecret);
        const ok = await crypto.subtle.verify("HMAC", key, signature, signed);
        if (!ok) throw unauthenticated();
        claims = payload as unknown as JwtClaims;
      } else {
        // No secret to check it with: ask GoTrue, which is the authority.
        claims = await this.#verifyRemotely(token, payload);
        local = false;
      }
    } else if (alg === "ES256" || alg === "RS256") {
      const kid = typeof header["kid"] === "string" ? header["kid"] : "";
      const key = await this.#jwksKey(kid, alg);
      if (!key) throw unauthenticated();
      const params = alg === "ES256"
        ? { name: "ECDSA", hash: "SHA-256" }
        : { name: "RSASSA-PKCS1-v1_5" };
      let ok = false;
      try {
        ok = await crypto.subtle.verify(params, key, signature, signed);
      } catch {
        ok = false;
      }
      if (!ok) throw unauthenticated();
      claims = payload as unknown as JwtClaims;
    } else {
      // "none", an empty alg, or anything this project does not sign with.
      throw unauthenticated();
    }

    this.#checkClaims(claims);
    if (local) {
      if (this.#verified.size >= 500) this.#verified.clear();
      this.#verified.set(token, claims);
    }
    return claims;
  }

  #checkClaims(claims: JwtClaims): void {
    const nowSec = this.#now() / 1000;
    const leeway = this.#cfg.leewaySec ?? 5;
    if (typeof claims.exp !== "number" || claims.exp + leeway <= nowSec) throw unauthenticated("Session expired.");
    if (typeof claims.nbf === "number" && claims.nbf - leeway > nowSec) throw unauthenticated();
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(EXPECTED_AUD)) throw unauthenticated();
    // The anon and service_role API keys are valid JWTs for this project too.
    // Only a signed-in user's token carries role "authenticated" and a uuid sub.
    if (claims.role !== "authenticated") throw unauthenticated();
    if (typeof claims.sub !== "string" || !UUID_RE.test(claims.sub)) throw unauthenticated();
    // `iss` is deliberately not compared. The signature was made with THIS
    // project's key (its JWKS or its secret), which is the proof of issuer;
    // the `iss` string differs between the default domain and a custom auth
    // domain, and comparing it would lock every user out on a domain change.
  }

  #hmacKey(secret: string): Promise<CryptoKey> {
    this.#hsKey ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return this.#hsKey;
  }

  async #jwksKey(kid: string, alg: "ES256" | "RS256"): Promise<CryptoKey | null> {
    const ttl = this.#cfg.jwksTtlMs ?? 10 * 60_000;
    const fresh = this.#jwks && this.#now() - this.#jwks.at < ttl;
    if (!fresh) await this.#loadJwks();
    let found = this.#jwks?.keys.get(`${alg}:${kid}`);
    if (!found && fresh && this.#now() - this.#jwksLastMissAt > 30_000) {
      // An unknown kid on a fresh cache is a key rotation, or an attacker
      // minting kids. Refetch at most once per 30 s either way.
      this.#jwksLastMissAt = this.#now();
      await this.#loadJwks();
      found = this.#jwks?.keys.get(`${alg}:${kid}`);
    }
    if (!found) return null;
    try {
      return await found;
    } catch {
      return null;
    }
  }

  #loadJwks(): Promise<void> {
    this.#jwksLoading ??= (async () => {
      try {
        const url = `${this.#cfg.supabaseUrl.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`;
        const resp = await this.#fetch(url, { headers: { accept: "application/json" } });
        if (!resp.ok) {
          await resp.body?.cancel().catch(() => {});
          return;
        }
        const body = await resp.json() as { keys?: Jwk[] };
        const keys = new Map<string, Promise<CryptoKey>>();
        for (const jwk of body.keys ?? []) {
          if (typeof jwk.kid !== "string") continue;
          if (jwk.kty === "EC" && jwk.crv === "P-256") {
            keys.set(
              `ES256:${jwk.kid}`,
              crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
            );
          } else if (jwk.kty === "RSA") {
            keys.set(
              `RS256:${jwk.kid}`,
              crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
                "verify",
              ]),
            );
          }
        }
        for (const key of keys.values()) key.catch(() => {});
        this.#jwks = { keys, at: this.#now() };
        this.#verified.clear();
      } catch {
        // Keep whatever was cached; a failed refresh must not log everyone out.
      } finally {
        this.#jwksLoading = null;
      }
    })();
    return this.#jwksLoading;
  }

  async #verifyRemotely(token: string, unverified: Record<string, unknown>): Promise<JwtClaims> {
    const cacheKey = await sha256Hex(token);
    const hit = this.#remote.get(cacheKey);
    if (hit && hit.until > this.#now()) return hit.claims;
    let resp: Response;
    try {
      resp = await this.#fetch(`${this.#cfg.supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
        headers: {
          authorization: `Bearer ${token}`,
          ...(this.#cfg.apiKey ? { apikey: this.#cfg.apiKey } : {}),
        },
      });
    } catch {
      throw new ApiError(503, "provider_error", "Could not verify the session. Try again.", { retryable: true });
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      throw unauthenticated();
    }
    const user = await resp.json() as { id?: string; email?: string; aud?: string; role?: string };
    if (typeof user.id !== "string") throw unauthenticated();
    // GoTrue vouched for the signature; identity comes from ITS answer, the
    // time bounds from the token it accepted.
    const claims: JwtClaims = {
      sub: user.id,
      email: user.email,
      exp: typeof unverified["exp"] === "number" ? unverified["exp"] as number : 0,
      aud: user.aud ?? EXPECTED_AUD,
      role: user.role ?? "authenticated",
    };
    const until = Math.min(this.#now() + 60_000, claims.exp * 1000);
    if (this.#remote.size > 2000) this.#remote.clear();
    this.#remote.set(cacheKey, { claims, until });
    return claims;
  }
}

export function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) throw unauthenticated();
  return match[1];
}

// ---------------------------------------------------------------------------
// Membership + gate
// ---------------------------------------------------------------------------

export interface MembershipSource {
  /** Live (not soft-deleted) workspaces this user belongs to. */
  memberships(userId: string): Promise<Membership[]>;
}

export class WorkspaceGate {
  readonly #cache = new Map<string, { rows: Membership[]; at: number }>();
  readonly #pending = new Map<string, Promise<Membership[]>>();
  constructor(
    private readonly source: MembershipSource,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async memberships(userId: string): Promise<{ rows: Membership[]; cached: boolean }> {
    const hit = this.#cache.get(userId);
    if (hit && this.now() - hit.at < this.ttlMs) return { rows: hit.rows, cached: true };
    return { rows: await this.#load(userId), cached: false };
  }

  /** One query per user at a time: concurrent cold requests share it. */
  #load(userId: string): Promise<Membership[]> {
    let pending = this.#pending.get(userId);
    if (!pending) {
      const started: Promise<Membership[]> = this.source.memberships(userId).then((loaded) => {
        const rows = loaded
          .slice()
          .sort((a, b) => a.joined_at.localeCompare(b.joined_at) || a.workspace_id.localeCompare(b.workspace_id));
        if (this.#cache.size > 5000) this.#cache.clear();
        this.#cache.set(userId, { rows, at: this.now() });
        return rows;
      }).finally(() => {
        if (this.#pending.get(userId) === started) this.#pending.delete(userId);
      });
      this.#pending.set(userId, started);
      pending = started;
    }
    return pending;
  }

  /**
   * Start loading a user's memberships without waiting, for a token that is
   * still being verified (see JwtVerifier.speculativeSubject). The result only
   * ever reaches a request that then proves it is this user. Never throws.
   */
  prefetch(userId: string): void {
    if (!UUID_RE.test(userId)) return;
    const hit = this.#cache.get(userId);
    if (hit && this.now() - hit.at < this.ttlMs) return;
    if (this.#pending.size > 200) return;
    this.#load(userId).catch(() => {});
  }

  /** Drop a user's cached memberships (tests, and after a gate refusal). */
  forget(userId: string): void {
    this.#cache.delete(userId);
  }

  /**
   * The workspace this request acts in. Throws `forbidden` for a workspace the
   * user is not in, `web_client_disabled` when the gate is shut.
   */
  async resolve(userId: string, requestedWorkspaceId: string | null): Promise<{
    memberships: Membership[];
    workspace: Membership;
    cached: boolean;
  }> {
    const { rows, cached } = await this.memberships(userId);
    if (rows.length === 0) throw forbidden("This account is not a member of any workspace.");
    let workspace: Membership | undefined;
    if (requestedWorkspaceId !== null) {
      if (!UUID_RE.test(requestedWorkspaceId)) throw forbidden("Unknown workspace.");
      workspace = rows.find((m) => m.workspace_id === requestedWorkspaceId.toLowerCase());
      // Same answer for "does not exist" and "not yours".
      if (!workspace) throw forbidden("Unknown workspace.");
    } else {
      workspace = rows.find((m) => m.web_client_enabled) ?? rows[0];
    }
    if (!workspace.web_client_enabled) {
      throw new ApiError(403, "web_client_disabled", "The web client is not enabled for this workspace.", {
        extra: { workspace_id: workspace.workspace_id },
      });
    }
    return { memberships: rows, workspace, cached };
  }
}

export function canWrite(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "member";
}
