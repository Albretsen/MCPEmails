import { multiMailboxFaq } from './multi-mailbox.mjs';
import { chatgptFaq, showsChatgptFaq } from './chatgpt.mjs';

/**
 * The FAQ on a /connect/<provider> page, in order: the provider's own entries,
 * then the several-mailboxes entry (business hosts only), then the ChatGPT
 * entry. The page renders this list and its FAQPage JSON-LD is built from the
 * same call, so the two cannot drift apart.
 */
export function providerFaq({ content, provider, multiMailbox = null, chatgptCopy = null }) {
  return [
    ...(content.faq ?? []),
    ...(multiMailbox ? [multiMailboxFaq(multiMailbox, provider.name)] : []),
    ...(chatgptCopy && showsChatgptFaq(provider) ? [chatgptFaq(chatgptCopy, provider.name)] : []),
  ];
}
