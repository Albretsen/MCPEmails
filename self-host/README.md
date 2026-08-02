# Self-host MCP Emails

Run the **exact MCP server that powers [mcpemails.com](https://mcpemails.com)** on your own
machine, against your own database. Your mailbox credentials never leave infrastructure you
control: they are encrypted with a key only you hold, decrypted only in your container, at the
moment a tool call needs them. No account, no API keys held by us, no Stripe, no telemetry.

This is part of our [trust & security commitment](https://mcpemails.com/security): the server is
open and auditable, and you can verify "email is fetched live and never stored" by running it
yourself and watching the network.

> **Scope.** This is the headless server: the MCP endpoint, its database, and a CLI to connect
> mailboxes and mint keys. It is **IMAP/SMTP-first** (Fastmail, iCloud, Yahoo, Zoho, Yandex, or any
> generic IMAP host via app password). Gmail/Outlook OAuth and the web dashboard are part of the
> hosted product and are intentionally out of scope here, they pull in OAuth client secrets, a
> session layer, and billing that a single-operator self-host does not need.

---

## What you get

```
┌──────────────┐   JSON-RPC over HTTP    ┌─────────────────────────────┐
│  MCP client  │  Authorization: Bearer  │  mcp-server  (Deno)         │
│ Claude/Cursor│ ─────────────────────▶  │  decrypts creds, fetches    │ ──▶ your mail
└──────────────┘     mcpe_… API key      │  live from your provider    │     (IMAP/SMTP)
                                         └────────────┬────────────────┘
                                                      │ supabase-js
                                         ┌────────────▼───────┐  ┌──────────────┐
                                         │ gateway (nginx)    │─▶│ PostgREST    │
                                         └────────────────────┘  └──────┬───────┘
                                                                        │
                                                                 ┌──────▼───────┐
                                                                 │ Postgres     │
                                                                 │ encrypted    │
                                                                 │ creds at rest│
                                                                 └──────────────┘
```

Four small containers, all on a private network. The MCP server is published only to
`127.0.0.1` by default, so its bearer-token endpoint is not reachable from your LAN or the
internet.

| Service | Image | Role |
| --- | --- | --- |
| `db` | `postgres:16` + baked schema | Stores inboxes (encrypted creds), hashed API keys, activity log, scheduled sends |
| `postgrest` | `postgrest/postgrest` | The REST layer the server talks to (`supabase-js`) |
| `gateway` | `nginx` | Exposes PostgREST under the `/rest/v1/` path the server expects |
| `mcp-server` | built from this repo's `supabase/functions/mcp-server` | The MCP server itself |
| `dispatcher` *(optional)* | `curlimages/curl` | Flushes scheduled sends once a minute |

## Requirements

- Docker + Docker Compose (Docker Desktop, or Docker Engine + the compose plugin)
- `make` (optional but recommended, every command below has a raw `docker compose` equivalent)

Nothing else. No Node, Deno, Supabase CLI, or database install on the host.

## Quick start

```bash
cd self-host

# 1. Generate secrets (encryption key, DB passwords, signed PostgREST tokens).
#    Writes .env. Run once, keep it private.
make setup

# 2. Build and start the stack.
make up

# 3. Connect a mailbox (app password, never your main account password).
#    The password is read from the IMAP_PASSWORD env var so it stays out of shell history.
export IMAP_PASSWORD='your-app-specific-password'
make provision \
  EMAIL=you@example.com \
  IMAP_HOST=imap.fastmail.com  SMTP_HOST=smtp.fastmail.com \
  IMAP_PORT=993 SMTP_PORT=465 \
  SERVICE=fastmail

# 4. Mint an MCP API key (printed once, copy it now).
make key NAME="my agent"
```

Now point any MCP client at **`http://localhost:8787`** with the key as a bearer token:

```jsonc
{
  "mcpServers": {
    "mcpemails": {
      "url": "http://localhost:8787",
      "headers": { "Authorization": "Bearer mcpe_your_key_here" }
    }
  }
}
```

Start a session with `inbox_list`; the server exposes the same ten action-based tools as the
hosted product (`inbox_list`, `email_read`, `email_organize`, `email_delete`, `email_compose`,
`folder`, `draft`, `schedule`, `signature`, `contact_search`).

## Remote access (HTTPS only)

The default endpoint is intentionally local-only. Do **not** make port `8787` public with a
firewall rule, router port-forward, or a Compose port override: it carries bearer tokens over
plain HTTP.

To let a remote MCP client connect, use the included Caddy HTTPS proxy. Before starting it,
create an `A`/`AAAA` DNS record for a hostname you control and point it at this host, then make
ports 80 and 443 reachable from the internet. Caddy uses port 80 for ACME validation and redirects
all HTTP traffic to HTTPS.

```bash
cd self-host
MCP_PUBLIC_HOST=mcp.example.com \
APP_URL=https://mcp.example.com \
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

Configure the remote client with `https://mcp.example.com` and the same `Authorization: Bearer`
header shown above. The base stack's `127.0.0.1:8787` listener remains local-only; Caddy reaches
the MCP container over Docker's private network. For an existing reverse proxy, proxy to
`http://127.0.0.1:8787`, terminate TLS there, preserve the `Authorization` header, and set
`APP_URL` to the resulting `https://` URL. Never expose the upstream HTTP listener directly.

## Common provider presets

| Provider | `SERVICE` | `IMAP_HOST` | `SMTP_HOST` | Ports |
| --- | --- | --- | --- | --- |
| Fastmail | `fastmail` | `imap.fastmail.com` | `smtp.fastmail.com` | 993 / 465 |
| iCloud | `icloud` | `imap.mail.me.com` | `smtp.mail.me.com` | 993 / 587 |
| Yahoo | `yahoo` | `imap.mail.yahoo.com` | `smtp.mail.yahoo.com` | 993 / 465 |
| Zoho | `zoho` | `imap.zoho.com` | `smtp.zoho.com` | 993 / 465 |
| Yandex | `yandex` | `imap.yandex.com` | `smtp.yandex.com` | 993 / 465 |
| Any IMAP host | `generic` | *your host* | *your host* | usually 993 / 465 |

> All of these require an **app-specific password** (not your login password), and IMAP/SMTP access
> enabled in the provider's settings. If the SMTP host uses STARTTLS, use port 587; implicit TLS is
> 465, the server picks the right handshake from the port.

## Managing the instance

| Command | What it does |
| --- | --- |
| `make up` / `make down` | Start / stop (data is preserved) |
| `make up SCHEDULER=1` | Also run the scheduled-send dispatcher |
| `make ps` / `make logs` | Status / tail logs (`make logs S=mcp-server` to scope) |
| `make inboxes` | List connected inboxes |
| `make keys` | List active API keys (prefixes only) |
| `make key NAME=… SCOPES=read:email,send:email INBOX=you@example.com EXPIRES_DAYS=90` | Mint a scoped, optionally inbox-restricted, expiring key |
| `make revoke PREFIX=mcpe_ab1` | Revoke a key by prefix |
| `make provision …` | Connect another mailbox |
| `make psql` | Open a `psql` shell |
| `make dispatch` | Manually flush due scheduled sends |
| `make destroy` | Stop and **delete all data** |

Scopes (grant the minimum your agent needs): `read:email`, `send:email`, `manage:folders`,
`delete:email`, `manage:drafts`, `manage:contacts`, `schedule:email`. A key with no `--scopes`
gets all of them; restrict with `INBOX=` to bind a key to specific mailboxes.

## Scheduled sends

The hosted product dispatches scheduled mail with `pg_cron` + Vault. The self-host stack replaces
that with a tiny poller: run `make up SCHEDULER=1` and the `dispatcher` container POSTs to
`/dispatch` (guarded by `DISPATCH_SECRET`) every minute. Prefer your own scheduler? Leave it off and
hit the endpoint yourself, e.g. from host cron:

```bash
curl -fsS -X POST -H "X-Dispatch-Secret: $DISPATCH_SECRET" http://localhost:8787/dispatch
```

## Security notes

- **Credentials at rest** are AES-256-GCM ciphertext, keyed by `ENCRYPTION_KEY` in your `.env`.
  Losing or rotating that key makes existing stored credentials undecryptable, back it up, never
  commit it. The same key encrypts scheduled-send payloads.
- **API keys** are stored only as SHA-256 hashes (`mcpe_` + 64 hex). The plaintext is shown once at
  creation and never recoverable.
- **Network exposure:** the database and PostgREST are not published, and the MCP server binds to
  `127.0.0.1` by default. For remote clients, use the included `docker-compose.tls.yml` Caddy
  proxy or an equivalent TLS-terminating reverse proxy. Set `APP_URL` to the public `https://` URL
  and do not publish or port-forward the plaintext MCP port.
- **No outbound calls to us.** The only network the server makes is to your mail provider and your
  own Postgres. Verify it: `make logs S=mcp-server` and watch.
- **Single-tenant.** One workspace, one operator, is seeded for you. Multi-user workspaces, roles,
  SSO, and audit-log retention are hosted-only features.

## How it maps to the hosted product

The `mcp-server` container runs `supabase/functions/mcp-server/` **unmodified**, the same code as
production. The only differences are operational, not behavioral:

| | Hosted (mcpemails.com) | Self-host |
| --- | --- | --- |
| Backend | Supabase (Postgres + PostgREST + Auth + Vault + cron) | Postgres + PostgREST only |
| Schema | 44 migrations (auth, billing, OAuth clients, partitioned logs) | one consolidated, dependency-free schema |
| Connect a mailbox | Web dashboard | `make provision` |
| Mint a key | Web dashboard | `make key` |
| Scheduled-send cron | `pg_cron` + Vault | a 60-second `curl` loop (or your own cron) |
| Gmail / Outlook OAuth | ✅ | ✗ (IMAP/SMTP via app password) |

## Troubleshooting

- **`postgrest` keeps restarting**, usually a stale volume from a previous `.env`. `make destroy`
  then `make up` to reinitialize the database with the current secrets.
- **`make setup` says `.env` already exists**, it refuses to overwrite, because regenerating
  `ENCRYPTION_KEY` would orphan stored credentials. Delete `.env` deliberately to start clean.
- **Auth errors from your client**, confirm the key is active (`make keys`) and the scope it needs
  is granted; the server returns `401` for unknown/expired keys, `403` for missing scopes.
