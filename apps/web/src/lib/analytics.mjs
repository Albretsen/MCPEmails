import { track } from '@vercel/analytics';

// This is deliberately a closed schema: callers cannot accidentally attach an
// identifier, URL, request payload, or mailbox data to a product event.
export const EVENT_SCHEMA = Object.freeze({
  signup_started: { method: ['password', 'google', 'github'] },
  signup_completed: { method: ['password', 'google', 'github'] },
  inbox_connect_started: { provider: ['gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex', 'imap'] },
  inbox_connected: { provider: ['gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex', 'imap'], connection_method: ['oauth', 'app_password'] },
  mcp_connection_started: { client: ['claude', 'chatgpt', 'cursor', 'vscode', 'cline', 'windsurf', 'gemini', 'zed', 'jetbrains', 'raycast', 'warp', 'curl', 'unknown'] },
  mcp_connection_authorized: { client: ['claude', 'chatgpt', 'cursor', 'vscode', 'cline', 'windsurf', 'gemini', 'zed', 'jetbrains', 'raycast', 'warp', 'curl', 'unknown'], scope_profile: ['read_only', 'read_send', 'custom'] },
  api_key_revealed: { scope_profile: ['read_only', 'read_send', 'custom'] },
  first_mcp_tool_call: { tool_name: ['inbox_list', 'email_read', 'email_compose', 'email_organize', 'folder', 'draft', 'schedule', 'contact_search'], provider: ['gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex', 'imap', 'unknown'], client: ['claude', 'chatgpt', 'cursor', 'vscode', 'cline', 'windsurf', 'gemini', 'zed', 'jetbrains', 'raycast', 'warp', 'curl', 'unknown'] },
  activation_completed: { activation_path: ['oauth', 'api_key'] },
});

const SENSITIVE_KEY = /(^|_)(id|email|address|token|secret|key|password|prompt|message|subject|body|attachment|url|uri|argument|payload)(_|$)/i;
const SENSITIVE_VALUE = /(mcpe_|bearer\s|@|https?:\/\/|token|password|api[_ -]?key)/i;

export function assertSafeAnalyticsEvent(name, properties = {}) {
  const schema = EVENT_SCHEMA[name];
  if (!schema) throw new Error(`Analytics event is not allowlisted: ${name}`);
  const keys = Object.keys(properties);
  if (keys.length !== Object.keys(schema).length || keys.some((key) => !(key in schema))) {
    throw new Error(`Analytics properties do not match schema for: ${name}`);
  }
  for (const [key, value] of Object.entries(properties)) {
    if (SENSITIVE_KEY.test(key) || typeof value !== 'string' || SENSITIVE_VALUE.test(value) || !schema[key].includes(value)) {
      throw new Error(`Unsafe analytics property: ${key}`);
    }
  }
}

export function trackProductEvent(name, properties = {}) {
  try {
    assertSafeAnalyticsEvent(name, properties);
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') throw error;
    return;
  }
  track(name, properties);
}

export function scopeProfile(scopes = []) {
  const scopeSet = new Set(scopes);
  if ([...scopeSet].every((scope) => scope === 'read:email' || scope === 'search:email')) return 'read_only';
  if (scopeSet.has('read:email') && scopeSet.has('send:email') && scopeSet.size <= 3) return 'read_send';
  return 'custom';
}
