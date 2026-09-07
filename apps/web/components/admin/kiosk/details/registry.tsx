/**
 * Which tiles are tappable, and what opens when they are.
 *
 * ONE TABLE, because the alternative is a `?detail=` value that means
 * something on one board and nothing on another. A tile names an id here; the
 * page resolves it or renders no panel at all. An unknown id is not an error
 * on this display: the URL is typed by hand into a Chromium autostart line on
 * a Pi with no keyboard, and a typo has to leave a working board on the wall
 * rather than an error page nobody is present to dismiss.
 *
 * EVERY PANEL TAKES THE WINDOW AND NOTHING ELSE. The window is the only piece
 * of board state a panel is allowed to care about: a panel that also knew
 * which view it was opened from would start rendering differently depending on
 * where the finger came from, which is exactly how two tiles end up showing
 * different numbers for the same metric.
 *
 * `window: 'fixed'` is for the panels whose subject has no window at all: a
 * Stripe subscription is live now, a provider mix is all-time, and printing
 * "last 28 days" over either of those would be a lie the switch above it makes
 * look authoritative.
 */

import type { ReactNode } from 'react';
import { ActiveUsersDetail } from './audience';
import {
  ActivationDetail,
  ChannelsDetail,
  ConvertDetail,
  SignupsDetail,
} from './acquisition';
import {
  ClientsDetail,
  EngagementDetail,
  RetentionDetail,
  ReturningDetail,
} from './engagement';
import {
  AtRiskDetail,
  CashDetail,
  CheckoutDetail,
  RevenueDetail,
  SubscribersDetail,
  ValuationDetail,
} from './money';
import { ErrorsDetail, IncidentsDetail, ReliabilityDetail } from './reliability';
import { GmailCapDetail, InboxCeilingDetail, ProvidersDetail, UsageDetail } from './capacity';

/** What every panel is handed. Deliberately one field. See above. */
export type KioskDetailProps = { days: number };

export type KioskDetailEntry = {
  /** The panel's own heading. Matches the tile that opens it, word for word. */
  title: string;
  /** The question it answers, in the header under the title. */
  question: string;
  /** Whether the board's window applies to this subject at all. */
  window: 'window' | 'fixed';
  /** What to print instead when it does not. */
  fixedWindow?: string;
  Panel: (props: KioskDetailProps) => ReactNode | Promise<ReactNode>;
};

export const KIOSK_DETAILS = {
  /* -------------------------------------------------------------- money */
  revenue: {
    title: 'Recurring revenue',
    question: 'what is actually recurring',
    window: 'fixed',
    fixedWindow: 'live subscriptions',
    Panel: RevenueDetail,
  },
  valuation: {
    title: 'Company valuation',
    question: 'the arithmetic, and what it is not',
    window: 'fixed',
    fixedWindow: 'live subscriptions',
    Panel: ValuationDetail,
  },
  subscribers: {
    title: 'Paying subscribers',
    question: 'who is on what',
    window: 'fixed',
    fixedWindow: 'live subscriptions',
    Panel: SubscribersDetail,
  },
  cash: {
    title: 'Cash collected',
    question: 'what actually arrived',
    window: 'fixed',
    fixedWindow: 'all time',
    Panel: CashDetail,
  },
  checkout: {
    title: 'Where the money is lost',
    question: 'which rung people fall off',
    window: 'fixed',
    fixedWindow: 'all time',
    Panel: CheckoutDetail,
  },
  'at-risk': {
    title: 'Money at risk',
    question: 'what is about to stop paying',
    window: 'fixed',
    fixedWindow: 'live subscriptions',
    Panel: AtRiskDetail,
  },

  /* -------------------------------------------------------- acquisition */
  signups: {
    title: 'Signed up',
    question: 'who is arriving, and when',
    window: 'window',
    Panel: SignupsDetail,
  },
  'active-users': {
    title: 'Active users',
    question: 'who came back, and how often',
    window: 'window',
    Panel: ActiveUsersDetail,
  },
  channels: {
    title: 'Where they come from',
    question: 'first touch, by channel',
    window: 'window',
    Panel: ChannelsDetail,
  },
  activation: {
    title: 'Road to a paying customer',
    question: 'every rung, and where it narrows',
    window: 'fixed',
    fixedWindow: 'all accounts, all time',
    Panel: ActivationDetail,
  },
  convert: {
    title: 'Still to convert',
    question: 'the free population, in bands',
    window: 'fixed',
    fixedWindow: 'all free workspaces',
    Panel: ConvertDetail,
  },

  /* --------------------------------------------------------- engagement */
  engagement: {
    title: 'How many days people showed up',
    question: 'the shape of the habit',
    window: 'window',
    Panel: EngagementDetail,
  },
  retention: {
    title: 'Retention after the first mailbox',
    question: 'which week it falls off',
    window: 'fixed',
    fixedWindow: 'external accounts, 12 weeks',
    Panel: RetentionDetail,
  },
  returning: {
    title: 'Came back',
    question: 'who used it on more than one day',
    window: 'window',
    Panel: ReturningDetail,
  },
  clients: {
    title: 'MCP client on first success',
    question: 'what people connect from',
    window: 'fixed',
    fixedWindow: 'all time',
    Panel: ClientsDetail,
  },

  /* -------------------------------------------------------- reliability */
  reliability: {
    title: 'Success rate',
    question: 'what share of attempted calls worked',
    window: 'window',
    Panel: ReliabilityDetail,
  },
  errors: {
    title: 'What is failing',
    question: 'by kind, and how concentrated',
    window: 'window',
    Panel: ErrorsDetail,
  },
  incidents: {
    title: 'Outage log',
    question: 'what the monitors have caught',
    window: 'fixed',
    fixedWindow: 'recent incidents',
    Panel: IncidentsDetail,
  },

  /* ----------------------------------------------------------- capacity */
  providers: {
    title: 'Connected inboxes',
    question: 'which providers people bring',
    window: 'fixed',
    fixedWindow: 'live connections',
    Panel: ProvidersDetail,
  },
  'gmail-cap': {
    title: 'Gmail OAuth headroom',
    question: 'how long the unverified cap lasts',
    window: 'fixed',
    fixedWindow: 'all time',
    Panel: GmailCapDetail,
  },
  'inbox-ceiling': {
    title: 'At the inbox ceiling',
    question: 'who the inbox paywall is in front of',
    window: 'fixed',
    fixedWindow: 'all workspaces',
    Panel: InboxCeilingDetail,
  },
  usage: {
    title: 'Work done for customers',
    question: 'what the product actually did',
    window: 'window',
    Panel: UsageDetail,
  },
} satisfies Record<string, KioskDetailEntry>;

export type KioskDetailId = keyof typeof KIOSK_DETAILS;

/** An unknown or missing `?detail=` opens nothing. See the header. */
export function resolveKioskDetail(raw: string | undefined): KioskDetailId | null {
  if (!raw) return null;
  return raw in KIOSK_DETAILS ? (raw as KioskDetailId) : null;
}
