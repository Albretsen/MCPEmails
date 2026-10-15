# SMTP submission relay

Optional non-AWS egress for the handful of mail hosts that refuse submission
from cloud addresses. Off unless `SMTP_RELAY_URL` is set.

## Why

The MCP edge function egresses from EC2 us-east-1, with reverse names like
`ec2-44-195-26-28.compute-1.amazonaws.com`. Some hosts refuse that as policy,
not reputation:

```
550 [ACR04] Amazon AWS IP 44.195.26.28 may not use this server.
Amazon servers should use Amazon SES (https://aws.amazon.com/ses/).
```

Domeneshop's own FAQ ("Hva kan jeg bruke smtp.domeneshop.no til?") says the
host is for personal mail clients and not for sending from cloud services, and
points AWS users at SES. That is a policy, so no retry schedule fixes it. On
2026-08-30 and again on 2026-08-31 it rejected roughly five of every six
submissions for `customer-29@redacted.invalid`; the occasional success is a gap in their
range list, not a working path.

The relay gives those hosts an address that is not in an AWS range. Every other
host keeps dialling directly, because the relay is a single point of failure
that the ~200 inboxes which have never had a problem should not be behind.

## How it works

`supabase/functions/mcp-server/smtp-relay.ts`, called from
`openGuardedSmtpConn` in `smtp-client.ts`.

1. The SMTP host is checked against `SMTP_RELAY_HOSTS`. No match means a direct
   dial, and nothing else in this document applies.
2. The host is validated by the SSRF guard exactly as on the direct path. A
   host the guard refuses is refused here too, and that is not a relay failure.
3. We open a TCP connection to the relay and ask for a tunnel:
   `CONNECT smtp.domeneshop.no:465 HTTP/1.1` with `Proxy-Authorization`.
4. On `200` the ordinary SMTP session runs inside the tunnel. TLS is negotiated
   with the mail host, end to end: the relay forwards ciphertext and never sees
   the mailbox password, and the certificate is still checked against the real
   hostname.

**Fallback.** Every failure up to and including the TLS handshake through the
tunnel (relay down, DNS wrong, `407`, a timeout, something that is not a proxy)
falls back to a direct dial. This is safe without further reasoning: all of it
happens before SMTP `DATA`, so nothing was transmitted and nothing can be
duplicated. After a failure the relay is skipped for 60 seconds per isolate, so
a dead relay costs one 5-second probe rather than one per send.

A rejection from the **mail host** is not a relay failure and does not fall
back. The tunnel worked; a direct retry would only reach the blocked address.

The relay handshake budget (5s) comes out of the same 20s connect budget the
direct dial already had, so adding the relay cannot push a submission past the
window the tool call was sized for.

## Configuration

Both are Supabase edge function secrets, not Vercel variables.

```bash
npx supabase secrets set SMTP_RELAY_URL=http://mcpe:PASSWORD@relay.example.net:3128 --project-ref swvaxorwumispmjaaszb
```

| Variable | Meaning |
| --- | --- |
| `SMTP_RELAY_URL` | `http://user:password@host:port`. Unset, unparseable, or not `http:` means relaying is off. Port defaults to 3128. |
| `SMTP_RELAY_HOSTS` | Comma-separated host suffixes to relay. Defaults to `domeneshop.no`. Matched on label boundaries: `domeneshop.no` covers `smtp.domeneshop.no`, never `notdomeneshop.no`. |

The scheme must be `http:`. The hop to the relay is plain HTTP because
`Deno.startTls` upgrades a TCP connection and the runtime cannot start TLS
inside TLS; paying for a TLS hop would mean giving the relay the cleartext SMTP
session and the password instead. What an on-path observer can see is the proxy
credential and the mail host's name, never the session.

Keep the host list short. Every entry gains a dependency on the relay.

## Standing the relay up

Any host **outside AWS** with a static address and a clean PTR. Hetzner,
DigitalOcean, Vultr, OVH all work; a Vercel or Lambda function does not, since
those are AWS too. Around 4 EUR/month.

tinyproxy is the smaller of the two options:

```conf
# /etc/tinyproxy/tinyproxy.conf
Port 3128
Listen 0.0.0.0
Timeout 120

# Source outgoing connections from the IPv4 address. This is not cosmetic:
# Domeneshop accepts our IPv4 address and answers the SAME box's IPv6 address
# with 550 [ACR07]. Without it the family is chosen by the resolver, and the
# outcome flips with it.
Bind <relay IPv4>

# CONNECT is only permitted to the submission ports.
ConnectPort 465
ConnectPort 587

# Anyone who finds the address still has to hold the credential.
BasicAuth mcpe PASSWORD

# Host filtering (the default mode, not FilterURLs) is what applies to a
# CONNECT request, where there is no URL to match, only an authority.
Filter "/etc/tinyproxy/filter"
FilterDefaultDeny Yes
FilterExtended Yes
```

```
# /etc/tinyproxy/filter: the only destinations worth allowing
^smtp\.domeneshop\.no$
```

squid, if you would rather have the destination allowlist as an ACL:

```conf
http_port 3128
auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwd
acl authenticated proxy_auth REQUIRED
acl relayed_hosts dstdomain .domeneshop.no
acl submission_ports port 465 587
http_access allow authenticated relayed_hosts submission_ports CONNECT
http_access deny all
```

Then:

- Firewall everything except the proxy port. Our egress addresses rotate across
  AWS, so the proxy port cannot be IP-allowlisted; the credential and the
  destination allowlist are what protect it.
- Generate the password with `openssl rand -hex 24` and rotate it by setting
  the secret and updating the proxy in either order (a failed relay falls back).
- Check the PTR resolves to a name you control and is not a cloud-provider
  default. It is what the mail host will judge.

## What the live path actually cost us

Three things that only showed up against the real hosts, all now encoded above.

**Hetzner blocks outbound SMTP.** From the relay box, ports 25 and 465 time out
on both address families; 587 connects in 274ms and Domeneshop answers
`220 ... ESMTP Exim 4.95`. The relay can therefore only carry STARTTLS
submission, and an inbox stored as 465/implicit TLS cannot use it at all.
Hetzner unblocks the ports on request for an established account; until then,
587 is the path.

**So the inbox has to be 587/STARTTLS**, which Domeneshop's own FAQ recommends
anyway and which works on the direct path too.

**Domeneshop judges IPv4 and IPv6 separately.** The first live send left over
the box's IPv6 address and came back:

```
550 [ACR07] Server IP <relay IPv6> may not use this server.
Please contact your hosting/cloud/RDP service provider for SMTP service.
```

A different rule from the AWS one (ACR04), aimed at hosting providers in
general. The identical send sourced from the box's IPv4 address was accepted.
That is what the `Bind` line pins, and it is the only reason the relay works.
It also means the arrangement rests on one address staying off their list: if
the relay's address is ever answered with an ACR code, the fix is not a code change
but a different egress address, or a mail host that permits programmatic
submission.

## Verifying

From any machine, that the proxy tunnels and authenticates:

```bash
curl -sv --proxy http://mcpe:PASSWORD@relay.example.net:3128 --proxytunnel https://smtp.domeneshop.no:465 2>&1 | grep -E 'CONNECT|established|407'
```

After deploying the function, that mail actually goes out: send one message
from the affected inbox and read the log line. A relayed send logs

```
[mcp-server] smtp_relay: connected { relay: "relay.example.net:3128", host: "smtp.domeneshop.no", port: 587 }
```

and a fallback logs `smtp_relay: falling back to direct egress` with the reason.
Both are `query_logs` on source `function_logs`. Counting `provider_not_sent` in
`activity_log` for the inbox is the outcome that matters: it should stop.

## Adding another provider

Usually nothing to do: since 2026-10-15 hosts are learned (next section). The
hand-kept list is for a host known in advance. Append the registrable domain to
`SMTP_RELAY_HOSTS` and set the secret. No code change and no deploy: the
function reads the secret per isolate.

## Learned hosts: the relay retry and `mail_relay_hosts`

A 2026-10-15 sweep of the connect logs found hosts refusing our AWS egress that
nobody reported (Telstra's submission port timed out 15 times for two
workspaces; both settled for a receive-only mailbox). So the hand-kept list is
now the floor:

1. **One relayed retry.** A direct connection that fails in a way a different
   address can fix is tried once more through the relay: a connect that never
   opened or went quiet, a greeting that turned us away, an SMTP rejection
   before DATA, or a login/envelope refusal whose own text blames where we
   connect from (`isOriginRefusalText`, two copies that a test keeps equal:
   `supabase/functions/mcp-server/relay-registry.ts` and
   `apps/web/src/lib/email/relay-fallback.ts`). Never a plain wrong password,
   a certificate problem or a name that does not resolve. Nothing can be sent
   twice: every retry happens before SMTP DATA. A host whose retry also failed
   is left alone for 10 minutes per isolate.
2. **Learning.** When the retry works, `learn_mail_relay_host` records the
   host per protocol, and from then on the connect form, the health check and
   the edge function (IMAP and SMTP) go through the relay first. A learned host
   whose relay is down falls back to a direct dial; only the relay-only list
   has no fallback. A relayed 465 row is submitted on 587 with STARTTLS.
3. **The learning rule** (migration `20261015200000`, after a false positive
   on 2026-10-15). One rescue only makes a host a *candidate*
   (`mail_relay_candidates`). It is learned at a second rescue at least 5
   minutes after the first, within 7 days, and never while it has 5 or more
   direct successful calls for that protocol in the last 7 days, however many
   failures it has. Failures prove nothing about our address: the first
   version compared successes with failures, and `exchange.ionos.eu` (82
   direct successes, 172 failures from two inboxes with wrong passwords) was
   learned after one dropped connection. Measured: Orange and Telstra
   submission 0, Domeneshop submission about 2 a week before it was relayed,
   Yahoo 29,023. A host that is never learned loses nothing: each failed call
   still gets its own relay retry.
4. **Re-check.** A learned row is honoured for 30 days from `last_learned_at`.
   After that connections are direct again and the host is re-learned by the
   same rule if it still needs the relay; only successes since it expired
   count, so the calls it made through the relay are not held against it.

Every relayed connection is counted in `mail_relay_stats` (hourly, per runtime,
protocol, host, route `listed`/`learned`/`fallback` and outcome
`ok`/`relay_down`/`host_refused`). The **Relay** band at the foot of
`/admin/growth` reads it: up or down, how many relayed connections worked, and
every host with its last failure. `relay_down` is ours; `host_refused` is the
mail host saying no through a working tunnel, usually a wrong password.

To relay a host by hand without waiting for a failure, insert a row with
`source = 'manual'` (never expires):

```sql
insert into mail_relay_hosts (host, protocol, source, reason)
values ('smtp.example.net', 'smtp', 'manual', 'why');
```

**Relay filter since 2026-10-15.** Learned hosts can be any mail host, so the
tinyproxy filter on the relay allows any DNS name with an alphabetic TLD (no IP
literal, no `localhost`) on `ConnectPort` 143, 465, 587 and 993 only, and
`MaxClients` is 100. Nothing on the relay box listens on those ports. The
previous host-by-host filter is in `/etc/tinyproxy/filter.bak-*`.

## Relay-only hosts: Orange (IMAP and SMTP, no direct fallback)

Domeneshop refuses our submissions. Orange refuses our **sign-ins**, for reading
as well as sending, and that needs more than the SMTP relay above.

**What was measured (2026-10-12).** `imap.orange.fr` answered every login from
our servers with `NO [ALERT] Authentication failed.`, which is not its
wrong-password answer: a made-up address gets `NO [AUTHENTICATIONFAILED] ...`
from AWS, from the relay and from a residential line, and Dovecot sends
`[ALERT]` only when its auth backend attached a refusal reason of its own.
Orange only issues mailboxes with a French internet contract, so the question
was put to one customer login, repeated from several addresses in a single
attempt:

| Login | From | Result |
| --- | --- | --- |
| IMAP | our web app (AWS) | `NO [ALERT] Authentication failed.` |
| IMAP | a relay in France | accepted |
| IMAP | this relay (Germany) | accepted |
| SMTP | our web app (AWS) | greeting `550 Service refused, please try later. OFR105_103` |
| SMTP, 587 | this relay (Germany) | accepted |

Same password throughout. Orange refuses real accounts from where we connect.

**What the code does about it.** `orange.fr` is a *relay-only* host, in both
runtimes, and the two lists must name the same hosts:

- Edge function: `DEFAULT_RELAY_ONLY_HOST_SUFFIXES` in `smtp-relay.ts`
  (override with the `MAIL_RELAY_ONLY_HOSTS` secret). IMAP for these hosts goes
  through the relay (`imap-client.ts#connectOnce`), they are always on the SMTP
  relay list whatever `SMTP_RELAY_HOSTS` says, and a row stored as 465 is
  submitted on 587 with STARTTLS.
- Web app: `RELAY_ONLY_MAIL_HOST_SUFFIXES` in
  `apps/web/src/lib/email/mail-relay.ts`, read from `MAIL_RELAY_URL` on Vercel.
  The connect form validates these hosts through the relay and stores SMTP as
  587/STARTTLS; the inbox health check opens its session the same way.

**No direct fallback, and the breaker does not skip them.** For every other
relayed host a broken relay degrades to a direct dial. Here the direct dial is
the one path known to be refused, and its refusal reads as a wrong password: it
would tell the user to reconnect a mailbox that is fine and count a failed
sign-in against their account. A relay that cannot carry the connection is an
ordinary transient failure for these hosts.

**Relay setup for a relay-only host**, on top of the above: `ConnectPort 993`,
and both the IMAP and the SMTP host in the filter file
(`^imap\.orange\.fr$`, `^smtp\.orange\.fr$`).

**Baselines worth knowing when reading logs.** Orange's wrong-password answers
are `NO [AUTHENTICATIONFAILED] Authentication failed.` on IMAP and
`550 5.7.0 ... Mot de passe invalide` on SMTP, the latter after about eight
seconds. An `[ALERT]` through the relay would mean the relay's own address has
started being refused, and no code change fixes that.

A second relay in France was stood up for the measurement. It is not used:
Orange's SMTP greets that address with `550 Service refused. OFR_99`, and the
German relay is accepted for both protocols.
