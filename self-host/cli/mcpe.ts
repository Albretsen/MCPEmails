#!/usr/bin/env -S deno run --allow-net --allow-env
// ============================================================
// mcpe, MCP Emails self-host CLI
// ============================================================
// Subcommands:
//   gen-secrets                 Print a ready-to-use .env (run once, on the host)
//   provision-inbox  [flags]    Connect an IMAP/SMTP mailbox (creds encrypted at rest)
//   create-key       [flags]    Mint a scoped MCP API key (printed once)
//   list-inboxes                List connected inboxes
//   list-keys                   List active API keys (prefixes only)
//   revoke-key       <prefix>   Soft-delete an API key by its prefix
//
// gen-secrets is pure-local (no DB). The rest talk to PostgREST via the
// gateway using SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, exactly like the
// server, so credential encoding round-trips byte-for-byte with production.
// ============================================================

const SEED_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const SEED_USER_ID = "00000000-0000-0000-0000-000000000001";

const ALL_SCOPES = [
  "read:email",
  "send:email",
  "manage:folders",
  "delete:email",
  "manage:drafts",
  "manage:contacts",
  "schedule:email",
];

const VALID_SERVICES = ["icloud", "yahoo", "zoho", "yandex", "generic", "fastmail"];

// ── small helpers ───────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(nBytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(nBytes)));
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToBytes(s: string): Uint8Array<ArrayBuffer> {
  // Return an explicitly ArrayBuffer-backed view so the result is a BufferSource.
  // TextEncoder.encode returns Uint8Array<ArrayBufferLike>, and a bare `Uint8Array`
  // return type stays ArrayBufferLike — both of which the strict WebCrypto lib
  // types reject as arguments to subtle.digest/sign/encrypt/importKey. Allocating
  // by length yields Uint8Array<ArrayBuffer>.
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(enc.length);
  out.set(enc);
  return out;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textToBytes(s));
  return bytesToHex(new Uint8Array(digest));
}

/** Mint an HS256 JWT, used to produce the PostgREST service_role / anon tokens. */
async function signJwt(secret: string, payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const enc = (o: unknown) => base64url(textToBytes(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    textToBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textToBytes(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

/**
 * AES-256-GCM encrypt → base64url (no padding). Byte-for-byte mirror of
 * apps/web/src/lib/crypto.ts#encryptToken and the server's encryptForStorage:
 * layout is IV(12) || ciphertext || authTag(16). The server decrypts these
 * with the same ENCRYPTION_KEY.
 */
async function encryptToken(plaintext: string, keyHex: string): Promise<string> {
  if (!keyHex || keyHex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
  }
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, cryptoKey, textToBytes(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return base64url(out);
}

// Tiny flag parser: --key value / --key=value, repeated keys collect to arrays.
function parseFlags(args: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    let key = a.slice(2);
    let val: string;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
    }
    if (key in out) {
      const cur = out[key];
      out[key] = Array.isArray(cur) ? [...cur, val] : [cur as string, val];
    } else {
      out[key] = val;
    }
  }
  return out;
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  Deno.exit(1);
}

// ── supabase-js client (same import the server uses) ─────────────────────────
async function getClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (start the stack, then use `make`).");
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdGenSecrets() {
  const jwtSecret = randomHex(40); // 80 hex chars, comfortably > 32 bytes for HS256
  const iat = 0; // fixed (no Date.now in some sandboxes); these are long-lived service tokens
  const serviceJwt = await signJwt(jwtSecret, { role: "service_role", iss: "mcpemails-selfhost", iat });
  const anonJwt = await signJwt(jwtSecret, { role: "anon", iss: "mcpemails-selfhost", iat });

  const env = `# ============================================================
# MCP Emails self-host, generated secrets. KEEP THIS FILE PRIVATE.
# Regenerating ENCRYPTION_KEY makes already-stored credentials undecryptable.
# ============================================================

# Postgres
POSTGRES_PASSWORD=${randomHex(24)}
AUTHENTICATOR_PASSWORD=${randomHex(24)}

# PostgREST JWT signing secret + the service_role token the MCP server presents
JWT_SECRET=${jwtSecret}
SERVICE_ROLE_JWT=${serviceJwt}
ANON_JWT=${anonJwt}

# AES-256-GCM key for credentials at rest (64 hex chars, never change after first inbox)
ENCRYPTION_KEY=${randomHex(32)}

# Secret guarding the POST /dispatch scheduled-send flush
DISPATCH_SECRET=${randomHex(32)}

# Public base URL of this server (used only for reconnect links in errors).
# For the optional TLS proxy, set it to https://<your DNS name>.
APP_URL=http://localhost:8787

# Host port the MCP server listens on -> http://localhost:<MCP_PORT>.
# It binds to 127.0.0.1 only and is not exposed to the LAN/internet.
MCP_PORT=8787
`;
  // Print to stdout so the caller can inspect or redirect (`> .env`).
  console.log(env);
}

async function cmdProvisionInbox(flags: Record<string, string | string[]>) {
  const keyHex = Deno.env.get("ENCRYPTION_KEY") ?? "";
  const email = flags.email as string;
  if (!email || email === "true") die("--email is required");

  const service = (flags.service as string) ?? "generic";
  if (!VALID_SERVICES.includes(service)) {
    die(`--service must be one of: ${VALID_SERVICES.join(", ")}`);
  }

  const imapHost = flags["imap-host"] as string;
  const smtpHost = flags["smtp-host"] as string;
  if (!imapHost || imapHost === "true") die("--imap-host is required");
  if (!smtpHost || smtpHost === "true") die("--smtp-host is required");

  const imapPort = parseInt((flags["imap-port"] as string) ?? "993", 10);
  const smtpPort = parseInt((flags["smtp-port"] as string) ?? "465", 10);

  // Prefer IMAP_PASSWORD from the environment so it stays out of shell history.
  const password = Deno.env.get("IMAP_PASSWORD") ?? (flags.password as string | undefined);
  if (!password || password === "true") {
    die("provide the app password via the IMAP_PASSWORD env var (preferred) or --password");
  }

  const encrypted = await encryptToken(password, keyHex);
  const username = (flags.username as string | undefined) && flags.username !== "true"
    ? (flags.username as string)
    : null;

  const supabase = await getClient();
  const { error } = await supabase.from("inboxes").upsert(
    {
      workspace_id: SEED_WORKSPACE_ID,
      provider: "imap",
      service,
      email_address: email,
      display_name: (flags["display-name"] as string | undefined) && flags["display-name"] !== "true"
        ? flags["display-name"]
        : null,
      imap_host: imapHost,
      imap_port: imapPort,
      imap_tls: true,
      imap_username: username,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_tls: true,
      imap_password: encrypted,
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_token_expires_at: null,
      oauth_scope: null,
      status: "active",
      last_error: null,
      deleted_at: null,
    },
    { onConflict: "workspace_id, email_address", ignoreDuplicates: false },
  );
  if (error) die(`failed to save inbox: ${error.message}`);
  console.log(`✓ connected ${email} (${service}, imap ${imapHost}:${imapPort} / smtp ${smtpHost}:${smtpPort})`);
}

async function cmdCreateKey(flags: Record<string, string | string[]>) {
  const name = (flags.name as string | undefined) && flags.name !== "true" ? (flags.name as string) : "self-host key";

  let scopes = ALL_SCOPES;
  if (flags.scopes && flags.scopes !== "true") {
    scopes = (flags.scopes as string).split(",").map((s) => s.trim()).filter(Boolean);
    const bad = scopes.filter((s) => !ALL_SCOPES.includes(s));
    if (bad.length) die(`unknown scope(s): ${bad.join(", ")}. Valid: ${ALL_SCOPES.join(", ")}`);
  }

  const supabase = await getClient();

  // Optional inbox restriction: --inbox accepts email addresses or UUIDs (repeatable).
  let inboxIds: string[] | null = null;
  const inboxRefs = asArray(flags.inbox).filter((v) => v && v !== "true");
  if (inboxRefs.length) {
    const { data, error } = await supabase
      .from("inboxes")
      .select("id, email_address")
      .eq("workspace_id", SEED_WORKSPACE_ID)
      .is("deleted_at", null);
    if (error) die(`could not resolve inboxes: ${error.message}`);
    const byEmail = new Map((data ?? []).map((r: { id: string; email_address: string }) => [r.email_address, r.id]));
    const ids = new Set((data ?? []).map((r: { id: string }) => r.id));
    inboxIds = inboxRefs.map((ref) => {
      if (ids.has(ref)) return ref;
      const id = byEmail.get(ref);
      if (!id) die(`no connected inbox matches "${ref}"`);
      return id;
    });
  }

  let expiresAt: string | null = null;
  const days = flags["expires-days"];
  if (days && days !== "true") {
    const ms = parseInt(days as string, 10) * 86_400_000;
    expiresAt = new Date(Date.now() + ms).toISOString();
  }

  // Key format the server expects: "mcpe_" + 64 hex chars (69 total).
  const key = `mcpe_${randomHex(32)}`;
  const keyHash = await sha256Hex(key);
  const keyPrefix = key.slice(0, 8);

  const { error } = await supabase.from("api_keys").insert({
    workspace_id: SEED_WORKSPACE_ID,
    created_by: SEED_USER_ID,
    name,
    key_prefix: keyPrefix,
    key_hash: keyHash,
    scopes,
    inbox_ids: inboxIds,
    expires_at: expiresAt,
  });
  if (error) die(`failed to create key: ${error.message}`);

  console.log("✓ API key created. Copy it now, it is not stored and cannot be shown again:\n");
  console.log(`    ${key}\n`);
  console.log(`  name:   ${name}`);
  console.log(`  scopes: ${scopes.join(", ")}`);
  console.log(`  inboxes: ${inboxIds ? inboxIds.length + " restricted" : "all"}`);
  if (expiresAt) console.log(`  expires: ${expiresAt}`);
}

async function cmdListInboxes() {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from("inboxes")
    .select("id, email_address, provider, service, status, imap_host, created_at")
    .eq("workspace_id", SEED_WORKSPACE_ID)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) die(error.message);
  if (!data?.length) {
    console.log("(no inboxes connected, run `make provision`)");
    return;
  }
  for (const r of data) {
    console.log(`${r.email_address}\t${r.provider}/${r.service ?? "-"}\t${r.status}\t${r.imap_host ?? ""}\t${r.id}`);
  }
}

async function cmdListKeys() {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from("api_keys")
    .select("key_prefix, name, scopes, inbox_ids, expires_at, last_used_at, created_at")
    .eq("workspace_id", SEED_WORKSPACE_ID)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) die(error.message);
  if (!data?.length) {
    console.log("(no active keys, run `make key`)");
    return;
  }
  for (const r of data) {
    const inb = r.inbox_ids ? `${r.inbox_ids.length} inbox(es)` : "all inboxes";
    console.log(`${r.key_prefix}…\t${r.name}\t[${(r.scopes ?? []).join(",")}]\t${inb}\tlast_used=${r.last_used_at ?? "never"}`);
  }
}

async function cmdRevokeKey(prefix: string | undefined) {
  if (!prefix) die("usage: revoke-key <key_prefix>  (e.g. mcpe_ab1)");
  const supabase = await getClient();
  const { data, error } = await supabase
    .from("api_keys")
    .update({ deleted_at: new Date().toISOString() })
    .eq("workspace_id", SEED_WORKSPACE_ID)
    .eq("key_prefix", prefix)
    .is("deleted_at", null)
    .select("key_prefix");
  if (error) die(error.message);
  if (!data?.length) die(`no active key with prefix "${prefix}"`);
  console.log(`✓ revoked key ${prefix}…`);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const [cmd, ...rest] = Deno.args;
const flags = parseFlags(rest);

switch (cmd) {
  case "gen-secrets":
    await cmdGenSecrets();
    break;
  case "provision-inbox":
    await cmdProvisionInbox(flags);
    break;
  case "create-key":
    await cmdCreateKey(flags);
    break;
  case "list-inboxes":
    await cmdListInboxes();
    break;
  case "list-keys":
    await cmdListKeys();
    break;
  case "revoke-key":
    await cmdRevokeKey(rest[0]);
    break;
  default:
    console.log(`mcpe, MCP Emails self-host CLI

Usage: mcpe <command> [flags]

Commands:
  gen-secrets                              Print a fresh .env to stdout
  provision-inbox --email <addr> \\
      --imap-host <h> --smtp-host <h> \\
      [--imap-port 993] [--smtp-port 465] \\
      [--username <u>] [--service generic] \\
      [--display-name <n>]                 Connect an IMAP/SMTP mailbox
                                           (password via IMAP_PASSWORD env)
  create-key [--name <n>] [--scopes a,b] \\
      [--inbox <addr|id> ...] \\
      [--expires-days <n>]                 Mint a scoped MCP API key
  list-inboxes                             List connected inboxes
  list-keys                                List active API keys
  revoke-key <key_prefix>                  Revoke an API key

Valid scopes: ${ALL_SCOPES.join(", ")}
Valid services: ${VALID_SERVICES.join(", ")}`);
    if (cmd && cmd !== "help" && cmd !== "--help") Deno.exit(1);
}
