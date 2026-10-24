/**
 * The first things to ask an AI app once MCPEmails is connected to it.
 *
 * WHY ONE LIST. A workspace that has an inbox and a connected app but never
 * makes a tool call usually stalls at "what do I say now". The suggested prompt
 * used to exist only in the API key reveal modal, so anyone who connected over
 * OAuth (Claude, ChatGPT and most others) never saw one. The getting-started
 * guide and the key reveal modal now read the same keys from here, so a prompt
 * is reworded in one place.
 *
 * The values are message keys in the `dashboard` namespace, not English: the
 * strings live in messages/<locale>/dashboard.json under `guide.prompts`.
 *
 * There is no OAuth success page to show them on: the consent screen
 * (components/auth/AuthorizeApp.jsx) sends the browser straight back to the
 * client's redirect URI the moment the user approves.
 */

/** In the order shown. The first one is the key reveal modal's single suggestion. */
export const FIRST_CALL_PROMPT_KEYS = Object.freeze([
  'guide.prompts.unread',
  'guide.prompts.bank',
  'guide.prompts.draftReply',
]);

/**
 * The per-chat switch each app needs before it can see the tools. The single
 * most likely reason a workspace has a credential and still no call: the
 * connector was added in settings and never switched on in the chat.
 */
const CLIENT_TOGGLE_KEYS = Object.freeze({
  claude: 'guide.clientToggle.claude',
  chatgpt: 'guide.clientToggle.chatgpt',
});

/** Message key of the in-chat switch line for `client`, or null when it has none. */
export function clientToggleKey(client) {
  return Object.prototype.hasOwnProperty.call(CLIENT_TOGGLE_KEYS, client) ? CLIENT_TOGGLE_KEYS[client] : null;
}

/**
 * Which version of guide step 2 to show.
 *
 *   'setup'    no inbox yet, or a tool call happened in an earlier month: the
 *              plain URL and client picker, as before.
 *   'waiting'  an inbox exists and this workspace has never made a tool call.
 *   'works'    the first call landed while the page was open.
 */
export function guideStep2Mode({ inboxCount, firstToolUsed, activatedLive }) {
  if (activatedLive) return 'works';
  if (inboxCount > 0 && !firstToolUsed) return 'waiting';
  return 'setup';
}

/** Poll cadence and lifetime for the waiting state. */
export const FIRST_CALL_POLL_MS = 10_000;
export const FIRST_CALL_POLL_MAX_MS = 15 * 60 * 1000;
