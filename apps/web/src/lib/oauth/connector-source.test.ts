// The connector attribution in src/lib/acquisition-context.mjs keeps its own
// copy of the vendor hosts and native-app schemes, because that file runs in
// the browser and in plain `node --test` with no TypeScript. This keeps the
// copy in step with client-identity.ts, the rule the consent screen uses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeClientIdentity, vendorForHost, type VendorId } from './client-identity.ts';
import {
  CONNECTOR_HOSTS,
  CONNECTOR_SCHEMES,
  SEEDED_CONNECTOR_CLIENTS,
} from '../acquisition-context.mjs';

const CONNECTOR_FOR_VENDOR: Partial<Record<VendorId, string>> = {
  anthropic: 'connector_claude',
  openai: 'connector_chatgpt',
  cursor: 'connector_cursor',
  vscode: 'connector_vscode',
};

test('every connector host belongs to the vendor the consent screen names', () => {
  for (const [hosts, source] of CONNECTOR_HOSTS) {
    for (const host of hosts) {
      const vendor = vendorForHost(host);
      assert.ok(vendor, host);
      assert.equal(CONNECTOR_FOR_VENDOR[vendor], source, host);
    }
  }
});

test('every connector scheme is a native app of the same vendor', () => {
  for (const [protocol, source] of Object.entries(CONNECTOR_SCHEMES)) {
    const identity = describeClientIdentity({
      clientId: 'dyn_test',
      clientName: 'Test',
      isCimd: false,
      redirectUri: `${protocol}//callback`,
    });
    assert.equal(identity.destinationKind, 'app', protocol);
    assert.ok(identity.destinationVendor, protocol);
    assert.equal(CONNECTOR_FOR_VENDOR[identity.destinationVendor], source, protocol);
  }
});

test('the four vendors are all covered', () => {
  const sources = new Set(CONNECTOR_HOSTS.map(([, source]) => source));
  for (const source of Object.values(CONNECTOR_FOR_VENDOR)) assert.ok(sources.has(source), source);
  for (const source of Object.values(SEEDED_CONNECTOR_CLIENTS)) assert.ok(sources.has(source), source);
});
