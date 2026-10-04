// Generates the VAPID key pair for web push (RFC 8292) and prints where each
// half goes. Run once, by the owner:
//
//   deno run scripts/generate-vapid-keys.ts
//   deno run scripts/generate-vapid-keys.ts mailto:you@example.com
//
// It needs no permissions, contacts nothing and writes nothing: the keys exist
// only in the terminal output. The PRIVATE key is a secret of the client-api
// edge function; the PUBLIC key is, as the name says, public (it is compiled
// into the web client and sent to every browser that subscribes).
//
// Running it AGAIN makes a NEW pair. Replacing the keys in production
// invalidates every existing subscription: each browser has to subscribe again
// (the client does that by itself the next time it is opened, see
// apps/client/src/platform/push.ts). So: generate once, keep the output.

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const subject = Deno.args[0] ?? "mailto:support@mcpemails.com";
if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
  console.error(`The subject must be a mailto: or https: contact, got "${subject}".`);
  Deno.exit(1);
}

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
if (!jwk.d) throw new Error("The private key could not be exported.");
// Normalised to unpadded base64url, 32 bytes.
const privateKey = jwk.d.replace(/=+$/, "");

console.log(`# 1. Edge function secrets (client-api reads these three):

supabase secrets set --project-ref swvaxorwumispmjaaszb \\
  VAPID_PUBLIC_KEY=${publicKey} \\
  VAPID_PRIVATE_KEY=${privateKey} \\
  VAPID_SUBJECT=${subject}

# 2. Web client build environment (Vercel project for apps/client, Production):

VITE_VAPID_PUBLIC_KEY=${publicKey}

# The public key in 1 and 2 must be the same value. Keep the private key out
# of git, chat and logs.`);
