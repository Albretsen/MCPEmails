export const ONBOARDING_CLIENTS = [
  'claude', 'chatgpt', 'cursor', 'vscode', 'cline', 'windsurf', 'gemini',
  'zed', 'jetbrains', 'raycast', 'warp', 'curl', 'unknown',
] as const;

export type OnboardingClient = typeof ONBOARDING_CLIENTS[number];
export type OnboardingAction = 'started' | 'client_selected' | 'provider_selected';

const clientSet = new Set<string>(ONBOARDING_CLIENTS);

export function normalizeOnboardingClient(value: unknown): OnboardingClient | null {
  return typeof value === 'string' && clientSet.has(value) ? value as OnboardingClient : null;
}

export function clientGuidePath(client: unknown): string {
  const normalized = normalizeOnboardingClient(client);
  return normalized ? `/dashboard?onboarding_client=${encodeURIComponent(normalized)}` : '/dashboard';
}

export function onboardingActionPayload(action: OnboardingAction, value?: unknown): Record<string, unknown> | null {
  if (action === 'started') return { action };
  if (action === 'client_selected') {
    const client = normalizeOnboardingClient(value);
    return client ? { action, client } : null;
  }
  const providers = new Set(['gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex', 'generic_imap', 'unknown']);
  return typeof value === 'string' && providers.has(value) ? { action, provider: value } : null;
}

