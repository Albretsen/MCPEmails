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
submissions for `hei@bonussok.no`; the occasional success is a gap in their
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

Only on evidence, meaning a logged rejection that names our sending address.
Append the registrable domain to `SMTP_RELAY_HOSTS`, add it to the relay's own
allowlist, and set the secret. No code change and no deploy: the function reads
the secret per isolate.
