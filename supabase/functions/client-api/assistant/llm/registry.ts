/* Chooses the provider and model from function secrets.
 *
 *   ASSISTANT_PROVIDER  default "openai"
 *   ASSISTANT_MODEL     default "gpt-5.4-mini"
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY
 *
 * An unknown provider or a missing key is `not_configured`: the run fails
 * closed with a user-safe error and nothing is sent anywhere.
 */

import { createAnthropicProvider } from "./anthropic.ts";
import { createOpenAiProvider } from "./openai.ts";
import { LlmError, type LlmProvider } from "./types.ts";

export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-5.4-mini";

export interface ResolvedProvider {
  provider: LlmProvider;
  model: string;
}

type Env = (name: string) => string | undefined;

const FACTORIES: Record<string, (env: Env) => LlmProvider> = {
  openai: (env) => {
    const apiKey = env("OPENAI_API_KEY");
    if (!apiKey) throw new LlmError("not_configured");
    return createOpenAiProvider({ apiKey, baseUrl: env("OPENAI_BASE_URL") || undefined });
  },
  anthropic: (env) => {
    const apiKey = env("ANTHROPIC_API_KEY");
    if (!apiKey) throw new LlmError("not_configured");
    return createAnthropicProvider({ apiKey });
  },
};

export function resolveProvider(env: Env): ResolvedProvider {
  const name = (env("ASSISTANT_PROVIDER") || DEFAULT_PROVIDER).trim().toLowerCase();
  const model = (env("ASSISTANT_MODEL") || DEFAULT_MODEL).trim();
  const factory = FACTORIES[name];
  if (!factory || !/^[A-Za-z0-9._:\-]{1,80}$/.test(model)) throw new LlmError("not_configured");
  return { provider: factory(env), model };
}
