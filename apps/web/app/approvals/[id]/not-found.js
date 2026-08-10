import { ApprovalNotFound } from '../../../components/approvals/ApprovalNotFound';

/**
 * Rendered for BOTH "no such approval" and "that approval belongs to a
 * workspace you are not in". The two must be indistinguishable — a review URL
 * travels through an AI conversation, and a page that answered differently for
 * a real id would turn this route into an existence oracle for other people's
 * outbound mail.
 */
export const metadata = {
  title: 'Review unavailable · MCP Emails',
  robots: { index: false, follow: false },
};

export default function ApprovalNotFoundPage() {
  return <ApprovalNotFound />;
}
