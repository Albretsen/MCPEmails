/* Seed data for the mock backend, ported from the design prototype
 * (Mail Client v7). `ago` is minutes before "now"; the mock turns it into a real
 * ISO date when it boots, so the list always looks current.
 *
 * The assistant-hint fields (ask, receipt, reply, ...) are NOT part of any wire
 * type. They are split off into a side table (see hints.ts) for the scripted
 * mock assistant to read.
 */

import type { Inbox, PlanSlug } from "../types";

export type MockBox = "gmail" | "outlook" | "imap";
export type MockProfile = "first" | "pro";

/** Mock-only knowledge about an email that the scripted assistant uses to act
 *  believably. A real assistant derives all of this by reading the message. */
export interface AssistantHints {
  /** What the sender wants, as a short imperative. */
  ask?: string;
  /** Same, phrased to follow "wants you to ...". */
  need?: string;
  receipt?: boolean;
  amount?: number;
  newsletter?: boolean;
  /** A human wrote it (so a reply makes sense). */
  person?: boolean;
  /** Sender is outside the user's organisation. */
  external?: boolean;
  summary?: string;
  reply?: string;
  shorter?: string;
  warmer?: string;
  answer?: string;
  quick?: string[];
  deadline?: string;
}

export interface SeedEmail extends AssistantHints {
  id: string;
  from: string;
  email: string;
  box: MockBox;
  /** inbox | sent | drafts | a custom folder name. */
  folder: string;
  ago: number;
  unread?: boolean;
  to?: string;
  isDraft?: boolean;
  /** The seed this one answers: they are one conversation (see THREADS below). */
  replyTo?: string;
  subject: string;
  snippet: string;
  body: string;
}

export type IncomingSeed = Omit<SeedEmail, "folder" | "ago">;

export const MOCK_INBOXES: Record<MockBox, Inbox> = {
  gmail: {
    inbox_id: "gmail",
    email_address: "jordan@gmail.com",
    display_name: "Personal",
    provider: "gmail",
    service: "gmail",
    sender_identities: [{ email_address: "jordan@gmail.com", display_name: "Jordan Reyes", is_default: true }],
    sender_identity_status: "available",
  },
  outlook: {
    inbox_id: "outlook",
    email_address: "jordan@northwind.co",
    display_name: "Northwind",
    provider: "outlook",
    service: "outlook",
    sender_identities: [{ email_address: "jordan@northwind.co", display_name: "Jordan Reyes", is_default: true }],
    sender_identity_status: "available",
  },
  imap: {
    inbox_id: "imap",
    email_address: "hi@jordanreyes.dev",
    display_name: "jordanreyes.dev",
    provider: "imap",
    service: null,
    sender_identities: [{ email_address: "hi@jordanreyes.dev", display_name: "Jordan Reyes", is_default: true }],
    sender_identity_status: "available",
  },
};

export const MOCK_USER = { name: "Jordan Reyes", initials: "JR" };

export const MOCK_PROFILES: Record<
  MockProfile,
  { label: string; boxes: MockBox[]; plan: PlanSlug; used: number; cap: number | null }
> = {
  first: { label: "First run · 1 mailbox", boxes: ["gmail"], plan: "free", used: 0, cap: 50 },
  pro: { label: "Pro · 3 mailboxes", boxes: ["gmail", "outlook", "imap"], plan: "solo", used: 312, cap: 1000 },
};

export const CUSTOM_FOLDERS = ["Receipts", "Travel"] as const;

export const SEED: SeedEmail[] = [
  {
    id: "maya", from: "Maya Chen", email: "maya@lattice-labs.io", box: "outlook", folder: "inbox", ago: 11, unread: true, person: true, external: true,
    subject: "Q4 renewal — can we do Thursday?",
    snippet: "Legal signed off on the updated terms. Could we do a quick call Thursday at 2pm…",
    body: "Hi Jordan,\n\nLegal signed off on the updated terms, so we're ready to move ahead with the renewal. The main change is the move to annual billing with the 12% discount we discussed.\n\nCould we do a quick call on Thursday at 2pm to walk through the order form? If that doesn't work, Friday morning is open too.\n\nThanks,\nMaya",
    ask: "Confirm the Thursday 2pm call",
    deadline: "She wants to meet Thursday at 2pm. Friday morning is her backup.",
    quick: ["Thursday at 2pm works. See you then.", "Friday morning is better for me.", "Thanks Maya, I'll confirm by end of day."],
    summary: "Legal approved the renewal: annual billing at 12% off. Maya wants a call Thursday at 2pm, or Friday morning.",
    answer: "She proposed Thursday at 2pm, with Friday morning as a backup. The call is to walk through the order form.",
    reply: "Hi Maya,\n\nGreat news, thanks for pushing this through legal. Thursday at 2pm works for me. I'll send a calendar invite with a video link shortly.\n\nAnnual billing with the 12% discount sounds right. Could you send the order form ahead of the call so I can loop in finance?\n\nBest,\nJordan",
    shorter: "Hi Maya,\n\nThursday at 2pm works. I'll send an invite shortly. Could you send the order form ahead of the call so I can loop in finance?\n\nBest,\nJordan",
    warmer: "Hi Maya,\n\nThis is great news, and thank you for getting it through legal so quickly. Thursday at 2pm works well for me. I'll send a calendar invite with a video link shortly.\n\nAnnual billing with the 12% discount sounds right. Could you send the order form ahead of the call so I can loop in finance?\n\nReally appreciate it,\nJordan",
  },
  {
    id: "stripe", from: "Stripe", email: "receipts@stripe.com", box: "gmail", folder: "inbox", ago: 110, receipt: true, amount: 96,
    subject: "Your receipt from Linear #2291-0443",
    snippet: "Amount paid $96.00 · Date paid Sep 30, 2026 · Visa ending 4242",
    body: "Receipt from Linear\n\nAmount paid: $96.00\nDate paid: September 30, 2026\nPayment method: Visa ending 4242\n\nLinear Standard — 6 seats × $16.00",
  },
  {
    id: "priya", from: "Priya Nair", email: "priya@northwind.co", box: "outlook", folder: "inbox", ago: 124, unread: true, person: true,
    subject: "Offsite agenda, final version",
    snippet: "Please flag anything by Friday so we can print. Can you take the Tuesday slot…",
    body: "Hi all,\n\nAttached is the final agenda for the October offsite. Please flag anything by Friday so we can send it to print.\n\nJordan, can you take the 30-minute slot on Tuesday afternoon for the platform roadmap?\n\nPriya",
    ask: "Take the Tuesday roadmap slot",
    deadline: "Agenda feedback is due Friday so it can go to print.",
    quick: ["Happy to take the Tuesday slot.", "Looks good, no changes from me.", "Can someone else take Tuesday?"],
    summary: "Final offsite agenda. Feedback due Friday. Priya asks you to take the Tuesday roadmap slot.",
    reply: "Hi Priya,\n\nThanks for pulling this together. Happy to take the Tuesday roadmap slot. I'll keep it to 30 minutes with time for questions.\n\nNo other changes from me.\n\nJordan",
  },
  {
    id: "vercel", from: "Vercel", email: "billing@vercel.com", box: "gmail", folder: "inbox", ago: 157, receipt: true, amount: 20,
    subject: "Invoice for September — Pro team",
    snippet: "Your invoice for $20.00 is available. Billing period Sep 1 – Sep 30.",
    body: "Your invoice is ready.\n\nTeam: northwind\nPlan: Pro\nAmount: $20.00\nBilling period: Sep 1 – Sep 30, 2026",
  },
  {
    id: "kenji", from: "Kenji Watanabe", email: "kenji@northwind.co", box: "outlook", folder: "inbox", ago: 1400, unread: true, person: true,
    subject: "Board update draft — Q3",
    snippet: "Here's my first draft of the Q3 board update. I'd like your comments by Friday…",
    body: "Hi Jordan,\n\nHere's my first draft of the Q3 board update. I'd like your comments by Friday so I can send it to the board on Monday.\n\nRevenue closed at $1.84M for the quarter, up 22% on Q2. Net revenue retention was 118%, mostly from seat expansion at our three largest accounts. Churn was concentrated in the self-serve tier, where we lost 41 accounts, most of them on the legacy plan we're retiring.\n\nOn hiring, we're proposing two backend roles in Q4 and holding the design role until we see how the agency engagement goes. That keeps burn at roughly $310K a month and runway at 26 months.\n\nThe biggest open question is pricing. I've included two options for the board: raise the Pro plan from $24 to $29 per seat, or keep the price and add usage-based billing for AI features. I lean toward the second, but I want your view before I commit to it in writing.\n\nThe full deck is in the shared drive under Board / 2026 / Q3.\n\nThanks,\nKenji",
    ask: "Comments on the board draft by Friday",
    need: "send comments on the board draft by Friday",
    deadline: "Friday. He plans to send it to the board on Monday.",
    quick: ["Thanks, I'll send comments by Thursday.", "Agree on usage-based pricing for AI.", "Can we go through it live tomorrow?"],
    summary: "Kenji wants your comments on the Q3 board update by Friday.\n\nRevenue was $1.84M, up 22%, with 118% net retention. He proposes two backend hires and holding the design role, which keeps runway at 26 months.\n\nThe open question is pricing: raise Pro to $29 per seat, or keep $24 and add usage-based billing for AI. He leans toward usage-based and wants your view.",
    reply: "Hi Kenji,\n\nThanks, this reads well. I'll send detailed comments by Thursday.\n\nOn pricing, I agree with usage-based billing for AI. It keeps Pro simple and ties cost to the feature that drives it.\n\nJordan",
  },
  {
    id: "ghpr", from: "GitHub", email: "notifications@github.com", box: "gmail", folder: "inbox", ago: 1500, unread: true,
    subject: "[northwind/api] PR #812: rate limit headers",
    snippet: "sam-okafor requested your review on this pull request",
    body: "@sam-okafor requested your review on northwind/api#812.\n\nAdds X-RateLimit-Remaining and X-RateLimit-Reset headers to every API response, plus tests.\n\n+184 −22 across 7 files",
  },
  {
    id: "aws", from: "Amazon Web Services", email: "aws-billing@amazon.com", box: "outlook", folder: "inbox", ago: 1600, receipt: true, amount: 412.18,
    subject: "AWS invoice available — September 2026",
    snippet: "Your invoice for account 4471-2093 is now available. Total $412.18.",
    body: "Your invoice for account 4471-2093 is now available.\n\nTotal: $412.18 USD\nBilling period: September 1 – 30, 2026",
  },
  {
    id: "pw", from: "Platform Weekly", email: "issue@platformweekly.dev", box: "imap", folder: "inbox", ago: 2000, unread: true, newsletter: true,
    subject: "Issue 88: The case for boring queues",
    snippet: "This week: job queues in Postgres, a migration story, and three tools…",
    body: "Issue 88\n\nThis week: job queues in Postgres, a migration story from a team of four, and three tools worth a look.",
  },
  {
    id: "delta", from: "Delta", email: "reservations@delta.com", box: "gmail", folder: "inbox", ago: 2900,
    subject: "Your trip to Denver is confirmed",
    snippet: "Confirmation HX4Q2L · Oct 14, DTW → DEN · Seat 12C",
    body: "Your trip is confirmed.\n\nConfirmation: HX4Q2L\nOct 14 · DL 1187 · DTW 8:05am → DEN 9:32am · Seat 12C\nOct 17 · DL 2210 · DEN 5:40pm → DTW 10:51pm · Seat 14A",
    answer: "You fly out Oct 14 at 8:05am (DL 1187, seat 12C) and come back Oct 17 at 5:40pm. Confirmation HX4Q2L.",
  },
  {
    id: "alex", from: "Alex Romero", email: "alex@romero.studio", box: "imap", folder: "inbox", ago: 3100, unread: true, person: true, external: true,
    subject: "Coffee next week?",
    snippet: "I'm in town the 8th and 9th. Would be good to catch up about the rebrand…",
    body: "Hey Jordan,\n\nI'm in town the 8th and 9th. Would be good to catch up about the rebrand and what you're planning for next year.\n\nAny morning work for you?\n\nAlex",
    ask: "Pick a morning, Oct 8 or 9",
    deadline: "He's in town Oct 8–9, so reply before then.",
    quick: ["The 9th works. 9am at Astro?", "The 8th is better for me.", "Busy both days, sorry. Next trip?"],
    summary: "Alex is in town Oct 8–9 and wants coffee about the rebrand.",
    reply: "Hey Alex,\n\nGood to hear from you. The morning of the 9th works. How about 9am at Astro on Main?\n\nJordan",
  },
  {
    id: "dd", from: "Design Digest", email: "hello@designdigest.co", box: "gmail", folder: "inbox", ago: 3300, unread: true, newsletter: true,
    subject: "Color systems that scale",
    snippet: "Five teams on how they name, test and ship color tokens.",
    body: "Five teams on how they name, test and ship color tokens.",
  },
  {
    id: "figc", from: "Figma", email: "no-reply@figma.com", box: "gmail", folder: "inbox", ago: 4300,
    subject: "Sam commented on Checkout v3",
    snippet: "\"Should the promo field collapse by default on mobile?\"",
    body: "Sam Okafor commented on Checkout v3:\n\n\"Should the promo field collapse by default on mobile? It pushes the pay button below the fold on smaller phones.\"",
  },
  {
    id: "ghr", from: "GitHub", email: "billing@github.com", box: "gmail", folder: "inbox", ago: 4400, receipt: true, amount: 44,
    subject: "[GitHub] Payment receipt for September",
    snippet: "We received payment for your GitHub Team plan. Amount $44.00.",
    body: "We received payment for your GitHub Team plan.\n\nOrganization: northwind\nAmount: $44.00\nCard: Visa ending 4242",
  },
  {
    id: "od", from: "Ops Dispatch", email: "dispatch@opsdispatch.io", box: "imap", folder: "inbox", ago: 5000, unread: true, newsletter: true,
    subject: "Incident reviews people actually read",
    snippet: "A template, two examples, and what to cut.",
    body: "A template, two examples, and what to cut.",
  },
  {
    id: "notion", from: "Notion", email: "receipts@notion.so", box: "gmail", folder: "inbox", ago: 5400, receipt: true, amount: 48,
    subject: "Your Notion receipt",
    snippet: "Plus plan · 6 members · $48.00",
    body: "Notion Plus plan, 6 members.\n\nAmount: $48.00",
  },
  {
    id: "hn", from: "Hacker Newsletter", email: "kale@hackernewsletter.com", box: "imap", folder: "inbox", ago: 5900, unread: true, newsletter: true,
    subject: "#712 — Postgres, queues, and taste",
    snippet: "This week: why your job queue should probably be a table",
    body: "Hacker Newsletter #712\n\nThis week: why your job queue should probably be a table, a long read on taste in software, and more.",
  },
  {
    id: "figr", from: "Figma", email: "billing@figma.com", box: "gmail", folder: "inbox", ago: 7300, receipt: true, amount: 45,
    subject: "Receipt for your Figma Professional plan",
    snippet: "Thanks for your payment of $45.00 for Figma Professional (3 editors).",
    body: "Thanks for your payment.\n\nFigma Professional — 3 editors\nAmount: $45.00\nDate: September 26, 2026",
  },
  {
    id: "uber", from: "Uber", email: "receipts@uber.com", box: "gmail", folder: "Receipts", ago: 12000,
    subject: "Your Tuesday evening trip with Uber", snippet: "Total $23.40 · 4.2 mi",
    body: "Thanks for riding, Jordan.\n\nTotal: $23.40",
  },
  {
    id: "hotel", from: "Hotel Teatro", email: "stay@hotelteatro.com", box: "gmail", folder: "Travel", ago: 14000,
    subject: "Reservation confirmed · Oct 14–17", snippet: "We look forward to welcoming you to Denver.",
    body: "Reservation confirmed for Oct 14–17.\n\nKing room, 3 nights.",
  },
  {
    id: "sent1", from: "You", email: "jordan@northwind.co", to: "kenji@northwind.co", box: "outlook", folder: "sent", ago: 5700,
    subject: "Hiring plan for Q1", snippet: "Here is my first pass at the Q1 plan…",
    body: "Here is my first pass at the Q1 plan. Two backend roles and one designer.",
  },
  {
    id: "draft1", from: "You", email: "jordan@northwind.co", to: "finance@northwind.co", box: "outlook", folder: "drafts", isDraft: true, ago: 3000,
    subject: "Budget for the offsite", snippet: "Hi team, a quick note on the offsite budget…",
    body: "Hi team, a quick note on the offsite budget",
  },
];

/* Conversations. Each is a chain of `replyTo` links inside one mailbox, with
 * the person's own replies in Sent: the list shows one row per conversation,
 * the reader shows the whole thread (the Sent messages arrive with the
 * `thread` call). One per provider, since each keys its threads differently:
 *   outlook  Sam Okafor, 3 messages, Inbox + Sent, the latest unread
 *   imap     Dana Whitfield, 4 messages, Inbox + Sent, all read
 *   gmail    GitHub, 3 notifications in the Inbox, the latest unread
 * Kept apart from SEED, and without assistant hints, so the prototype's first
 * screen and the scripted assistant's emails are what they were. */
export const THREADS: SeedEmail[] = [
  {
    id: "limits-1", from: "Sam Okafor", email: "sam@northwind.co", box: "outlook", folder: "inbox", ago: 900,
    subject: "Limits rollout: flag first or straight to everyone?",
    snippet: "The new rate limits are ready. I'd rather ship behind the flag for a week…",
    body: "Hi Jordan,\n\nThe new rate limits are ready to go. I'd rather ship them behind the flag for a week and watch the 429s before turning them on for everyone.\n\nThe risk with going straight to everyone is the three accounts that batch at midnight.\n\nSam",
  },
  {
    id: "limits-2", from: "You", email: "jordan@northwind.co", to: "sam@northwind.co", box: "outlook", folder: "sent", ago: 840, replyTo: "limits-1",
    subject: "Re: Limits rollout: flag first or straight to everyone?",
    snippet: "Flag first. Can you warn the three batch accounts before we flip it?",
    body: "Flag first. Can you warn the three batch accounts before we flip it? I'd like them to hear it from us, not from a 429.\n\nJordan",
  },
  {
    id: "limits-3", from: "Sam Okafor", email: "sam@northwind.co", box: "outlook", folder: "inbox", ago: 610, unread: true, replyTo: "limits-2",
    subject: "Re: Limits rollout: flag first or straight to everyone?",
    snippet: "Done. Two of the three replied already. Flag goes on Monday unless you say otherwise.",
    body: "Done. Two of the three replied already and are fine with it; I'm chasing the third.\n\nThe flag goes on Monday morning unless you say otherwise.\n\nSam",
  },
  {
    id: "dana-1", from: "Dana Whitfield", email: "dana@whitfield-legal.com", box: "imap", folder: "inbox", ago: 2600,
    subject: "Contractor agreement: two points to decide",
    snippet: "Redlines attached. Two points need a decision from you: the IP clause and the notice period.",
    body: "Jordan,\n\nRedlines attached. Two points need a decision from you:\n\n1. The IP assignment clause. Their counsel wants a carve-out for pre-existing tools.\n2. The notice period. They ask for 30 days; our template says 14.\n\nDana",
  },
  {
    id: "dana-2", from: "You", email: "hi@jordanreyes.dev", to: "dana@whitfield-legal.com", box: "imap", folder: "sent", ago: 2500, replyTo: "dana-1",
    subject: "Re: Contractor agreement: two points to decide",
    snippet: "Fine with the carve-out if it is a named list. 30 days is too long; could we meet at 21?",
    body: "Fine with the carve-out as long as it is a named list of tools, not a category.\n\n30 days is too long for a contractor. Could we meet at 21?\n\nJordan",
  },
  {
    id: "dana-3", from: "Dana Whitfield", email: "dana@whitfield-legal.com", box: "imap", folder: "inbox", ago: 2300, replyTo: "dana-2",
    subject: "Re: Contractor agreement: two points to decide",
    snippet: "They accept a named list and 21 days. I will send the clean copy for signature tomorrow.",
    body: "They accept a named list and 21 days.\n\nI will send the clean copy for signature tomorrow.\n\nDana",
  },
  {
    id: "dana-4", from: "You", email: "hi@jordanreyes.dev", to: "dana@whitfield-legal.com", box: "imap", folder: "sent", ago: 2250, replyTo: "dana-3",
    subject: "Re: Contractor agreement: two points to decide",
    snippet: "Thank you. Send it over whenever it is ready.",
    body: "Thank you. Send it over whenever it is ready.\n\nJordan",
  },
  {
    id: "gh-1", from: "GitHub", email: "notifications@github.com", box: "gmail", folder: "inbox", ago: 1750,
    subject: "[northwind/web] PR #1204: tidy up the settings form",
    snippet: "priya-nair opened this pull request. +212 −148 across 9 files",
    body: "@priya-nair opened northwind/web#1204.\n\nSplits the settings form into sections and removes the two dead toggles.\n\n+212 −148 across 9 files",
  },
  {
    id: "gh-2", from: "GitHub", email: "notifications@github.com", box: "gmail", folder: "inbox", ago: 1700, replyTo: "gh-1",
    subject: "Re: [northwind/web] PR #1204: tidy up the settings form",
    snippet: "sam-okafor commented: the timezone select lost its label.",
    body: "@sam-okafor commented on northwind/web#1204:\n\nThe timezone select lost its label in the move. Otherwise this reads well.",
  },
  {
    id: "gh-3", from: "GitHub", email: "notifications@github.com", box: "gmail", folder: "inbox", ago: 1650, unread: true, replyTo: "gh-2",
    subject: "Re: [northwind/web] PR #1204: tidy up the settings form",
    snippet: "priya-nair pushed 1 commit and requested your review.",
    body: "@priya-nair pushed 1 commit to northwind/web#1204 and requested your review.\n\nRestores the label on the timezone select.",
  },
];

/** Fed one at a time by `simulateIncoming()`. */
export const INCOMING: IncomingSeed[] = [
  {
    id: "new1", from: "Sam Okafor", email: "sam@northwind.co", box: "outlook", person: true,
    subject: "Re: PR #812 — ready for another look",
    snippet: "Addressed your comments on the reset header. Should be good to merge.",
    body: "Addressed your comments on the reset header. Should be good to merge once CI is green.\n\nSam",
    ask: "Re-review PR #812",
    reply: "Thanks Sam. I'll take another look this afternoon.\n\nJordan",
  },
  {
    id: "new2", from: "Linear", email: "receipts@linear.app", box: "gmail", receipt: true, amount: 16,
    subject: "Receipt for an added seat", snippet: "1 seat added · $16.00",
    body: "1 seat added to Standard.\n\nAmount: $16.00",
  },
  {
    id: "new3", from: "Maya Chen", email: "maya@lattice-labs.io", box: "outlook", person: true, external: true,
    subject: "Order form attached",
    snippet: "Here is the order form for Thursday. Let me know if finance has questions.",
    body: "Here is the order form for Thursday. Let me know if finance has questions.\n\nMaya",
  },
];

const HINT_KEYS: (keyof AssistantHints)[] = [
  "ask", "need", "receipt", "amount", "newsletter", "person", "external",
  "summary", "reply", "shorter", "warmer", "answer", "quick", "deadline",
];

export function hintsOf(seed: AssistantHints): AssistantHints | null {
  const out: Record<string, unknown> = {};
  for (const k of HINT_KEYS) if (seed[k] !== undefined) out[k] = seed[k];
  return Object.keys(out).length ? (out as AssistantHints) : null;
}

/* ------------------------------------------------------------------
 * Generated filler: ~400 plausible inbox messages from a seeded RNG, so list
 * virtualisation and pagination are exercised for real. Deterministic: the
 * same ids, senders and subjects on every boot.
 * ------------------------------------------------------------------ */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLER_SENDERS: { from: string; email: string; box: MockBox; subjects: string[]; lines: string[] }[] = [
  { from: "Sam Okafor", email: "sam@northwind.co", box: "outlook",
    subjects: ["Review notes on the billing refactor", "Standup moved to 10:30", "Flaky test in the importer", "Rollout plan for the new limits", "Postmortem draft, please skim"],
    lines: ["I left comments inline. Nothing blocking, mostly naming.", "Can you take a look before Thursday's sync?", "I'd rather ship this behind the flag first."] },
  { from: "Priya Nair", email: "priya@northwind.co", box: "outlook",
    subjects: ["Headcount sheet for next quarter", "Vendor shortlist for the offsite", "Notes from the customer call", "Roadmap review: agenda", "Who owns the pricing page?"],
    lines: ["Summary is in the doc. The short version: we're on track.", "Let me know if the dates work for your team.", "Happy to walk through it live if that's easier."] },
  { from: "Linear", email: "notifications@linear.app", box: "gmail",
    subjects: ["API-412 was assigned to you", "API-398 moved to In Review", "Cycle 31 summary", "API-405: new comment from Kenji", "3 issues are due this week"],
    lines: ["Open the issue to see the full thread.", "You are receiving this because you are subscribed to this issue."] },
  { from: "GitHub", email: "notifications@github.com", box: "gmail",
    subjects: ["[northwind/api] CI failed on main", "[northwind/web] PR #1204: tidy up the settings form", "[northwind/api] Dependabot: bump pg from 8.11 to 8.13", "[northwind/infra] Release v2.14.0", "[northwind/web] Issue #988: slow first paint on /reports"],
    lines: ["View it on GitHub to reply or change your notification settings.", "2 checks failed, 14 passed."] },
  { from: "Google Calendar", email: "calendar-notification@google.com", box: "gmail",
    subjects: ["Invitation: Platform sync", "Updated invitation: 1:1 with Kenji", "Reminder: Design review at 3pm", "Accepted: Quarterly planning", "Invitation: Customer call with Lattice Labs"],
    lines: ["Joining info is in the event.", "Reply for jordan@gmail.com: Yes, Maybe, No."] },
  { from: "Dana Whitfield", email: "dana@whitfield-legal.com", box: "imap",
    subjects: ["Contractor agreement, redlines", "Trademark filing status", "Question about the NDA template", "Invoice 2209 for September", "Updated terms for the reseller deal"],
    lines: ["Redlines attached. Two points need a decision from you.", "No rush, but before month end would be ideal."] },
  { from: "Sentry", email: "noreply@sentry.io", box: "outlook",
    subjects: ["New issue: TimeoutError in /v1/export", "Weekly report for northwind-api", "Regression: NullPointer in importer", "Spike in 5xx on checkout", "Issue resolved: slow query in reports"],
    lines: ["First seen 12 minutes ago, 38 events, 21 users affected.", "This issue was last seen in release 2.14.0."] },
  { from: "Tomás Herrera", email: "tomas@herrera.design", box: "imap",
    subjects: ["Logo explorations, round two", "Invoice for the brand sprint", "Type pairing options", "Quick question on the icon set", "Site map draft"],
    lines: ["Three directions attached. My pick is the second.", "Tell me which way you lean and I'll take it further."] },
  { from: "The Pragmatic Engineer", email: "pulse@pragmaticengineer.com", box: "imap",
    subjects: ["The Pulse: hiring is back, sort of", "What senior actually means", "Inside a platform team of six", "How teams measure developer productivity", "The Pulse: on-call, revisited"],
    lines: ["This week's issue looks at how small teams run platform work.", "You're on the free list. Upgrade to read the full archive."] },
  { from: "Chase", email: "no-reply@alerts.chase.com", box: "gmail",
    subjects: ["Your statement is ready", "A payment of $1,240.00 posted", "Your credit card payment is scheduled", "New sign-in to your account", "Your balance is below $500"],
    lines: ["Sign in to view the details. We will never ask for your password by email."] },
  { from: "Notion", email: "notify@mail.notion.so", box: "gmail",
    subjects: ["Priya mentioned you in Q4 plan", "Kenji commented on Board notes", "Weekly digest for Northwind", "You were added to Platform wiki", "Reminder: review the launch checklist"],
    lines: ["Open in Notion to reply.", "3 pages were updated since your last visit."] },
  { from: "Hana Kobayashi", email: "hana@lattice-labs.io", box: "outlook",
    subjects: ["Security questionnaire for procurement", "Follow-up on the pilot", "SSO setup, next steps", "Usage numbers you asked for", "Intro: our new CTO"],
    lines: ["Procurement needs this back by the 15th.", "Thanks for the quick turnaround last week."] },
];

export interface FillerEmail {
  id: string;
  from: string;
  email: string;
  box: MockBox;
  ago: number;
  unread: boolean;
  has_attachments: boolean;
  subject: string;
  snippet: string;
  body: string;
}

export const FILLER_COUNT = 400;

export function generateFiller(count = FILLER_COUNT, seed = 20261003): FillerEmail[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)] as T;
  const out: FillerEmail[] = [];
  // Starts after the oldest hand-written inbox seed so the first screen is the prototype's.
  let ago = 7600;
  for (let i = 0; i < count; i++) {
    ago += 45 + Math.floor(rnd() * 620);
    const s = pick(FILLER_SENDERS);
    const subject = pick(s.subjects);
    const first = pick(s.lines);
    const second = pick(s.lines);
    const body = second === first ? first : `${first}\n\n${second}`;
    out.push({
      id: `g${String(i + 1).padStart(3, "0")}`,
      from: s.from,
      email: s.email,
      box: s.box,
      ago,
      unread: rnd() < 0.12,
      has_attachments: rnd() < 0.1,
      subject,
      snippet: first,
      body,
    });
  }
  return out;
}

/* ------------------------------------------------------------------
 * Rich content for a handful of seeds: an HTML body and/or attachments,
 * keyed by seed id. Deliberately includes what real mail carries (remote
 * images, a tracking pixel, a <style> block, a script, an onclick) so the
 * reader's sanitizer and sandbox are exercised in the mock.
 * ------------------------------------------------------------------ */

export interface SeedRich {
  html?: string;
  attachments?: { filename: string; mime_type: string; size_bytes: number }[];
}

const cell = "padding:10px 0;border-bottom:1px solid #DEE1EB";

export const SEED_RICH: Record<string, SeedRich> = {
  stripe: {
    html:
      `<style>body{background:#f6f9fc}</style>` +
      `<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px"><tr><td>` +
      `<img src="https://stripe-images.example.com/linear-logo.png" alt="Linear" width="48" height="48">` +
      `<h2 style="margin:12px 0 4px">Receipt from Linear</h2>` +
      `<p style="color:#626A7D;margin:0 0 16px">Receipt #2291-0443</p>` +
      `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">` +
      `<tr><td style="${cell};color:#626A7D">Amount paid</td><td align="right" style="${cell};font-weight:600">$96.00</td></tr>` +
      `<tr><td style="${cell};color:#626A7D">Date paid</td><td align="right" style="${cell}">September 30, 2026</td></tr>` +
      `<tr><td style="${cell};color:#626A7D">Payment method</td><td align="right" style="${cell}">Visa ending 4242</td></tr>` +
      `<tr><td style="${cell}">Linear Standard, 6 seats &times; $16.00</td><td align="right" style="${cell}">$96.00</td></tr>` +
      `</table>` +
      `<p style="margin:16px 0 0">Questions? <a href="https://linear.app/contact" onclick="track()">Contact Linear</a> or reply to this email.</p>` +
      `<script>window.location="https://example.com/track"</script>` +
      `<img src="https://stripe-images.example.com/open.gif" width="1" height="1" alt="">` +
      `</td></tr></table>`,
    attachments: [{ filename: "Receipt-2291-0443.pdf", mime_type: "application/pdf", size_bytes: 48_211 }],
  },
  pw: {
    html:
      `<div style="max-width:560px">` +
      `<img src="https://cdn.platformweekly.example/header-88.png" alt="Platform Weekly">` +
      `<h1 style="font-size:20px">Issue 88: The case for boring queues</h1>` +
      `<p>This week: job queues in Postgres, a migration story from a team of four, and three tools worth a look.</p>` +
      `<h3>1. Queues in Postgres</h3>` +
      `<p>You probably do not need a broker. <code>SELECT ... FOR UPDATE SKIP LOCKED</code> takes you a long way, and it is one less system to run. <a href="https://platformweekly.example/88/queues">Read the piece</a>.</p>` +
      `<blockquote>We deleted 4,000 lines and nobody noticed.</blockquote>` +
      `<h3>2. A migration story</h3>` +
      `<p>Four engineers, one weekend, zero downtime. The interesting part is what they chose <em>not</em> to move.</p>` +
      `<h3>3. Three tools</h3>` +
      `<ul><li><a href="https://example.com/a">pgmq</a>: a queue as an extension</li><li><a href="https://example.com/b">river</a>: jobs for Go</li><li><a href="javascript:alert(1)">graphile-worker</a>: jobs for Node</li></ul>` +
      `<hr><p style="font-size:12px;color:#626A7D">You get this because you subscribed. <a href="https://platformweekly.example/unsubscribe">Unsubscribe</a></p>` +
      `</div>`,
  },
  priya: {
    attachments: [
      { filename: "Offsite agenda (final).pdf", mime_type: "application/pdf", size_bytes: 184_320 },
      { filename: "Room plan.png", mime_type: "image/png", size_bytes: 612_004 },
    ],
  },
  kenji: {
    attachments: [
      { filename: "Q3 board update (draft 1).docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size_bytes: 92_160 },
      { filename: "Q3 metrics.xlsx", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size_bytes: 31_744 },
    ],
  },
};
