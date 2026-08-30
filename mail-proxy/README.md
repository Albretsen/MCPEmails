# mail-proxy

A TCP forwarder with a fixed IP address, for getting mail out through hosts
that refuse Amazon's ranges.

## Why

The MCP server runs on Supabase, which runs on AWS. Some mail hosts refuse SMTP
submission from those ranges outright. Proved against Domeneshop on 2026-08-30
by running the identical unauthenticated SMTP sequence from two places:

```
from a Norwegian consumer line:   550 relay not permitted
from AWS, ports 465 and 587:      550 [ACR04] Amazon AWS IP <addr> may not use
                                      this server
```

No credential is involved in that refusal, so no retry and no port change can
route around it. The connection has to originate somewhere else.

## What it is not

It is not an SMTP relay. It never parses SMTP, never authenticates to a mail
host, and never holds a message. The edge function opens a socket through it
and then runs TLS over that socket itself, so the session terminates at the
mail host and this process forwards ciphertext it cannot read.

That is enforced rather than promised: an impostor in the middle would have to
present a certificate for the mail host's name, and the client checks it. Such
an attacker can deny service, not read a password.

## Install

On a small Ubuntu machine whose IP is not in a cloud range (Hetzner, or any VPS
where you control reverse DNS):

```
scp -r mail-proxy root@<ip>:/tmp/
ssh root@<ip> 'MAIL_PROXY_SECRET=<secret> /tmp/mail-proxy/install.sh'
```

Then point the edge function at it:

```
npx supabase secrets set --project-ref <ref> \
  MAIL_PROXY_HOST=<ip> MAIL_PROXY_PORT=8443 MAIL_PROXY_SECRET=<secret>
npx supabase functions deploy mcp-server --project-ref <ref> --no-verify-jwt
```

With those unset, every send goes direct exactly as before. The proxy is opt-in
so that a proxy outage cannot take down sending for the hosts that never needed
it.

## How sending uses it

Direct first, proxy second. A send only reaches the proxy after a direct
attempt was refused before the message was transmitted, which is the one moment
a retry provably cannot duplicate anything. Hosts that accept us keep sending
directly and never touch this box.

## Operating it

```
systemctl status mail-proxy
journalctl -u mail-proxy -f
```

Each tunnel logs one line. `bad signature` lines mean someone is probing, or
the secret has drifted between the two ends.

## Rotating the secret

Set the new value on the proxy first (it accepts only one at a time, so expect
a few seconds of failed sends, which surface as retryable and are safe):

```
ssh root@<ip> 'MAIL_PROXY_SECRET=<new> /tmp/mail-proxy/install.sh'
npx supabase secrets set --project-ref <ref> MAIL_PROXY_SECRET=<new>
```

## Firewall

Only the listening port needs to be open. It is authenticated, refuses anything
but ports 465/587/993/143, and refuses private and metadata addresses even to a
caller holding the secret. Port 25 is deliberately not on that list: nothing we
do needs server-to-server delivery, and it is the port that would make this box
worth stealing.
