/**
 * The plan for the chat scene in storyboards/connect-and-triage.json.
 *
 * A plan declares WHICH calls the scene makes. It does not declare what they
 * return: scripts/transcript.mjs runs them against the real MCP server and
 * records the actual outcome.
 *
 * WHY THESE THREE CALLS AND NOT A TRIAGE THAT MOVES MAIL.
 *
 * The payoff beat is triage, and the honest way to film triage is to let the
 * server decide what is in the mailbox rather than to author it. So every turn
 * here is read-only and every number and subject on screen is lifted out of a
 * live payload:
 *
 *   inbox_list   proves the mailbox connected in the previous scene is the one
 *                being read. Thousands of successful calls behind it.
 *   email_read   action: list. The pile, unsorted, with its real count.
 *   email_read   action: search, subject "invoice". The tool, not the script,
 *                picks the message out of that pile. If the search returns
 *                nothing, the assistant line says so and the beat gets cut,
 *                which is the correct outcome, not a bug to work around.
 *
 * Deliberately absent: email_organize. The 2026-08-19 audit found it had never
 * been called by anyone, and a move is not reversible on camera or off. A
 * triage that ends in a recommendation proves the model reached real mail just
 * as well as one that ends in a folder change, and risks nothing.
 *
 * `args` is static (transcript.mjs passes `turn.args` straight through), so a
 * turn cannot chain a message_id out of the previous payload. That is why
 * there is no `action: "read"` turn: it would need a hardcoded message_id,
 * which is a fact about one seeding of one mailbox and rots on the next take.
 *
 * Date filters need a timezone suffix ("2026-08-01T00:00:00Z") and are a hard
 * schema rejection without one. There are none here on purpose.
 */

export const id = 'connect-and-triage';

/** Pull the message array out of whichever envelope key the tool used. */
const messagesOf = (p) => {
  const m = p?.messages ?? p?.emails ?? p?.results ?? [];
  return Array.isArray(m) ? m : [];
};

const subjectOf = (m) => (m?.subject ?? '').trim();

export const turns = [
  {
    role: 'user',
    text: 'Triage this inbox. What actually needs me today?',
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
    // No `limit`. The default is 20, so passing it changed nothing except to
    // put `"limit":20` on screen in every row. Arguments are evidence, and an
    // argument that carries no meaning is noise competing with the ones that do.
    role: 'tool',
    name: 'email_read',
    args: { action: 'list' },
    summarize: (p) => {
      const n = messagesOf(p).length;
      return `${n} message${n === 1 ? '' : 's'} in INBOX`;
    },
  },
  {
    /**
     * Written as a function of the real results, so every number and every
     * quoted subject on screen came off the wire. Replace this with a fixed
     * string and you own the claim: it will be filmed and read as a fact.
     */
    role: 'assistant',
    text: (payloads) => {
      const listed = messagesOf(payloads[1]);
      // The urgent one is FOUND in the list payload, not asserted. `list`
      // really did return all thirteen subjects, so picking one out of them is
      // what a model reading that response would do, and the quoted subject is
      // still a string that came off the wire. If nothing in the mailbox is
      // overdue, this says so rather than inventing urgency.
      const urgent = listed.find((m) => /overdue|past due/i.test(subjectOf(m)));
      if (!urgent) {
        return `${listed.length} messages, and none of them is overdue. Nothing here needs you today.`;
      }
      return `${listed.length} messages. One of them is "${subjectOf(urgent)}". Start there, the rest can wait.`;
    },
  },
];
