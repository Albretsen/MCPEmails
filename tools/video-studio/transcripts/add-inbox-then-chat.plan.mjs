/**
 * The plan for the chat scene in storyboards/add-inbox-then-chat.json.
 *
 * A plan declares WHICH calls the scene makes. It does not declare what they
 * return: scripts/transcript.mjs runs them against the real MCP server and
 * records the actual outcome. `summarize` turns a real payload into the short
 * line the scene puts on screen, so even that line is a function of live data.
 *
 * Two rules when editing this file:
 *
 *   1. Only call tools that have a track record. As of the 2026-08-19 audit,
 *      inbox_list, email_read and contact_search had thousands of successful
 *      calls between them; email_compose had 29 errors and no successes, and
 *      email_organize, draft, folder and schedule had never been called at all.
 *      Putting an untried tool in a plan is how a video ends up demonstrating
 *      something that does not work.
 *
 *   2. Date filters need a timezone suffix. "2026-08-01" is the format the
 *      tool's own description gives as an example and it is a hard schema
 *      rejection. Use "2026-08-01T00:00:00Z", or leave the date filter out,
 *      which is safer on camera anyway.
 */

export const id = 'add-inbox-then-chat';

export const turns = [
  {
    role: 'user',
    text: 'What came in on the new inbox this morning?',
  },
  {
    role: 'tool',
    name: 'inbox_list',
    args: {},
    summarize: (p) => {
      const list = Array.isArray(p?.inboxes) ? p.inboxes : [];
      if (list.length === 0) return 'no inboxes';
      const first = list[0]?.email_address ?? 'inbox';
      return list.length === 1 ? `1 inbox: ${first}` : `${list.length} inboxes`;
    },
  },
  {
    role: 'tool',
    name: 'email_read',
    // No date filter on purpose: see rule 2 above. `limit` keeps the payload
    // small enough to summarise honestly.
    args: { action: 'list', limit: 10 },
    summarize: (p) => {
      const msgs = p?.messages ?? p?.emails ?? [];
      const n = Array.isArray(msgs) ? msgs.length : 0;
      return `${n} message${n === 1 ? '' : 's'}`;
    },
  },
  {
    role: 'assistant',
    /**
     * Written as a function of the real results, so the number on screen is
     * the number the server returned. If you replace this with a fixed string,
     * you own that claim: it will be filmed, and it will be read as a fact
     * about the product.
     */
    text: (payloads) => {
      const listed = payloads[1];
      const msgs = listed?.messages ?? listed?.emails ?? [];
      const n = Array.isArray(msgs) ? msgs.length : 0;
      return `I can see ${n} message${n === 1 ? '' : 's'} in that mailbox. Ask me to triage them, draft a reply, or file the noise, and I will work through them one at a time.`;
    },
  },
];
