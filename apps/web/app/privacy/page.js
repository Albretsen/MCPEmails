import { Nav, Footer } from '../../components/marketing/Sections';
import { LAST_UPDATED, EFFECTIVE_DATE } from '@/lib/legal-config';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

export const metadata = {
  title: 'Privacy Policy',
  description: 'How MCPEmails collects, uses, and protects your data. Our privacy policy for users, workspace owners, and AI agents.',
  alternates: {
    canonical: `${APP_URL}/privacy`,
  },
  openGraph: {
    type: 'website',
    url: `${APP_URL}/privacy`,
    title: 'Privacy Policy · mcpemails',
    description: 'How MCPEmails collects, uses, and protects your data. Our privacy policy for users, workspace owners, and AI agents.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'mcpemails Privacy Policy',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Privacy Policy · mcpemails',
    description: 'How MCPEmails collects, uses, and protects your data.',
    images: ['/og.png'],
  },
};

/* ─── Section data ───────────────────────────────────────────── */

const CONTACT_EMAIL = 'privacy@mcpemails.com';
const COMPANY_NAME = 'MCPEmails';
const COMPANY_ADDRESS = 'Oslo, Norway';

/* ─── Page ───────────────────────────────────────────────────── */

export default function PrivacyPage() {
  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero" style={{ paddingBottom: 48 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="eye-label">Legal</div>
          <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>
            Privacy Policy
          </h1>
          <p className="pricing-page-lead" style={{ maxWidth: 600 }}>
            We built MCPEmails with privacy as a first principle. Your email content
            is never stored on our servers — it passes through to your agent and
            disappears. This policy explains what we do collect, and why.
          </p>
          <p style={{ fontSize: 13, color: 'var(--fg-4)', marginTop: 8 }}>
            Last updated: {LAST_UPDATED} &nbsp;·&nbsp; Effective: {EFFECTIVE_DATE}
          </p>
        </div>
      </section>

      {/* Body */}
      <section className="section" style={{ paddingTop: 16, paddingBottom: 80 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="legal-body">

            {/* 1 — Who we are */}
            <LegalSection id="who-we-are" title="1. Who We Are">
              <p>
                {COMPANY_NAME} ("MCPEmails", "we", "us", or "our") operates the
                MCPEmails service available at <strong>mcpemails.com</strong>, including
                all dashboard pages, API endpoints, and the Model Context Protocol (MCP)
                server that AI agents use to access connected email accounts.
              </p>
              <p>
                For the purposes of applicable data protection law (including the EU General
                Data Protection Regulation, "GDPR"), MCPEmails is the data controller for
                account and usage data. For email content, we act as a data processor on
                your behalf — we transmit content you authorise us to retrieve, and we do
                not store it.
              </p>
              <p>
                Our registered address is: {COMPANY_ADDRESS}.
                You can reach our privacy team at{' '}
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
              </p>
            </LegalSection>

            {/* 2 — Data we collect */}
            <LegalSection id="data-we-collect" title="2. Data We Collect">

              <h4>2.1 Account data</h4>
              <p>
                When you create an account we collect your email address and a hashed
                password (we never store plaintext passwords). You may optionally provide
                a display name. This data is required to create and maintain your account.
              </p>

              <h4>2.2 Workspace and configuration data</h4>
              <p>
                We store the workspace name you choose, and the configuration of each
                connected inbox (provider type, email address, OAuth status, and
                connection timestamp). We do <strong>not</strong> store OAuth access tokens
                or app passwords in plaintext — they are encrypted with AES-256-GCM before
                being written to the database, and the encryption key is stored in a
                separate secrets vault.
              </p>

              <h4>2.3 API keys</h4>
              <p>
                We store a SHA-256 hash of each API key you create, along with the key's
                name, scopes, creation timestamp, and last-used timestamp. The raw key
                value is shown to you exactly once at creation time and is never stored
                in recoverable form.
              </p>

              <h4>2.4 Usage and audit logs</h4>
              <p>
                For every MCP tool call your agent makes, we record: the tool name
                (e.g. <code>read_email</code>), the API key that made the call, the inbox
                that was accessed, the timestamp, and whether the call succeeded. We do
                <strong> not</strong> record email subjects, bodies, recipients, or any
                other email content in these logs.
              </p>

              <h4>2.5 Email content — not stored</h4>
              <p>
                When your agent calls <code>read_email</code>, <code>list_inbox</code>, or
                any other email tool, we fetch the requested content live from your email
                provider and return it to your agent in the same HTTP response. The content
                is never written to disk, cached, or logged. Once the HTTP response is
                sent, we hold no copy of any email body, subject, attachment, or contact
                detail.
              </p>

              <h4>2.6 Technical and operational data</h4>
              <p>
                We collect standard server-side operational data including IP addresses
                (for rate limiting and abuse prevention), request timestamps, HTTP status
                codes, and error types. This data is retained in aggregated, anonymised
                form and is not linked to individual accounts after 30 days.
              </p>

              <h4>2.7 Cookies and local storage</h4>
              <p>
                The dashboard sets one first-party session cookie issued by Supabase Auth
                to keep you signed in. We do not use tracking cookies, advertising cookies,
                or any third-party cookies. We store a single theme preference
                (<code>mcpe-theme</code>) in your browser's local storage.
              </p>
            </LegalSection>

            {/* 3 — How we use data */}
            <LegalSection id="how-we-use-data" title="3. How We Use Your Data">
              <p>We use the data described above for the following purposes:</p>

              <h4>3.1 Providing the service</h4>
              <p>
                We use your account data to authenticate you, your workspace configuration
                to route MCP tool calls to the correct email provider, and your API keys to
                authorise agent requests. Without this data the service cannot function.
                The legal basis under GDPR is <strong>performance of a contract</strong>.
              </p>

              <h4>3.2 Security and abuse prevention</h4>
              <p>
                We use IP addresses, request rates, and error patterns to detect and block
                abusive activity, enforce rate limits, and protect the availability of the
                service for all users. The legal basis is our <strong>legitimate interests</strong>{' '}
                in operating a secure service.
              </p>

              <h4>3.3 Usage analytics and product improvement</h4>
              <p>
                We use aggregated, anonymised usage data (tool call counts, error rates,
                latency) to understand how the service is used and to prioritise
                improvements. We do not use individual-level usage data for this purpose.
                The legal basis is our <strong>legitimate interests</strong> in improving
                the service.
              </p>

              <h4>3.4 Billing and plan enforcement</h4>
              <p>
                We use usage counts to determine whether your workspace has reached plan
                limits and to calculate your invoice on paid plans. The legal basis is
                <strong> performance of a contract</strong>.
              </p>

              <h4>3.5 Legal compliance</h4>
              <p>
                We may process and disclose data where required by applicable law, court
                order, or regulatory authority. The legal basis is <strong>compliance with
                a legal obligation</strong>.
              </p>

              <h4>3.6 What we will never do</h4>
              <ul>
                <li>Sell your personal data or usage data to third parties.</li>
                <li>Use your email content for training AI models.</li>
                <li>Use your data to serve you advertising.</li>
                <li>Share your data with third parties for their own marketing purposes.</li>
              </ul>

              <h4>3.7 Google API Services — Limited Use</h4>
              <p>
                MCPEmails' use and transfer to any other app of information received from
                Google APIs (including the Gmail API) will adhere to the{' '}
                <a
                  href="https://developers.google.com/terms/api-services-user-data-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Google API Services User Data Policy
                </a>
                , including the <strong>Limited Use</strong> requirements.
              </p>
              <p>
                When you connect a Gmail account, you grant MCPEmails the following Gmail
                scopes. We request each scope solely to provide the features you invoke
                through your AI agent, and we use them only on your behalf:
              </p>
              <ul>
                <li>
                  <code>gmail.readonly</code> — list messages and read message contents so
                  your agent can search, read, and summarise email at your request.
                </li>
                <li>
                  <code>gmail.send</code> — compose and send messages that your agent creates
                  at your request.
                </li>
                <li>
                  <code>gmail.modify</code> — apply and remove labels and move messages to
                  trash when your agent organises your mailbox at your request.
                </li>
              </ul>
              <p>Consistent with the Limited Use requirements, MCPEmails:</p>
              <ul>
                <li>
                  uses Google user data only to provide and improve the user-facing features
                  described above;
                </li>
                <li>
                  does not transfer or sell Google user data to third parties, data brokers,
                  or advertising networks;
                </li>
                <li>does not use Google user data for serving advertisements;</li>
                <li>
                  does not use Google user data to develop, improve, or train generalised or
                  non-personalised AI or machine-learning models;
                </li>
                <li>
                  does not allow humans to read Google user data unless (a) you give explicit
                  consent for specific messages, (b) it is necessary for security purposes
                  such as investigating abuse, (c) it is required to comply with applicable
                  law, or (d) the data has been aggregated and anonymised.
                </li>
              </ul>
              <p>
                As described in Section 2.5, email content retrieved from the Gmail API is
                streamed through to your agent in the same request and is never stored,
                cached, or logged by MCPEmails.
              </p>
            </LegalSection>

            {/* 4 — Data retention */}
            <LegalSection id="data-retention" title="4. Data Retention">
              <p>We keep each category of data for the following periods:</p>

              <div className="legal-table-wrap">
                <table className="legal-table">
                  <thead>
                    <tr>
                      <th>Data category</th>
                      <th>Retention period</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Account data (email, display name)</td>
                      <td>Until account deletion, plus 30 days</td>
                      <td>Service operation; recovery window</td>
                    </tr>
                    <tr>
                      <td>Workspace and inbox configuration</td>
                      <td>Until deleted by you, plus 30 days</td>
                      <td>Service operation; recovery window</td>
                    </tr>
                    <tr>
                      <td>Encrypted OAuth tokens / app passwords</td>
                      <td>Until inbox disconnected or account deleted</td>
                      <td>Required to authenticate provider API calls</td>
                    </tr>
                    <tr>
                      <td>API key hashes</td>
                      <td>Until revoked, plus 30 days</td>
                      <td>Audit trail; recovery window</td>
                    </tr>
                    <tr>
                      <td>MCP tool call audit logs</td>
                      <td>90 days (Free &amp; Pro) · 1 year (Enterprise)</td>
                      <td>Security audit; plan feature</td>
                    </tr>
                    <tr>
                      <td>Aggregated usage metrics</td>
                      <td>2 years</td>
                      <td>Billing history; product analytics</td>
                    </tr>
                    <tr>
                      <td>Server operational logs (IP, status)</td>
                      <td>30 days raw; anonymised aggregate retained</td>
                      <td>Abuse prevention; availability</td>
                    </tr>
                    <tr>
                      <td>Email content</td>
                      <td>Not stored — zero retention</td>
                      <td>Privacy by design</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <p>
                When you delete your account, we initiate deletion of all personal data
                within 30 days. Aggregated, non-personal usage statistics derived from your
                account may be retained beyond this period in anonymised form.
              </p>
            </LegalSection>

            {/* 5 — Third parties */}
            <LegalSection id="third-parties" title="5. Third Parties and Data Sharing">

              <h4>5.1 Infrastructure providers (data processors)</h4>
              <p>
                We use the following sub-processors to operate the service. Each is bound
                by a Data Processing Agreement and processes data only on our instructions:
              </p>

              <div className="legal-table-wrap">
                <table className="legal-table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Purpose</th>
                      <th>Data processed</th>
                      <th>Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><strong>Supabase</strong></td>
                      <td>Database, auth, edge functions</td>
                      <td>Account data, workspace config, audit logs</td>
                      <td>EU (Frankfurt) or US (Virginia) — you choose at signup</td>
                    </tr>
                    <tr>
                      <td><strong>Vercel</strong></td>
                      <td>Web hosting, CDN</td>
                      <td>HTTP request metadata; no email content</td>
                      <td>Global edge (nearest region to user)</td>
                    </tr>
                    <tr>
                      <td><strong>Stripe</strong> (paid plans only)</td>
                      <td>Payment processing</td>
                      <td>Billing email, payment card data (stored by Stripe, not us)</td>
                      <td>US (Stripe is PCI-DSS certified)</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h4>5.2 Email providers (your providers, not ours)</h4>
              <p>
                When you connect Gmail, Outlook, or a Fastmail / IMAP account, MCPEmails
                authenticates with that provider using credentials you supply. Your email
                provider's own privacy policy governs the data held in your mailbox.
                MCPEmails accesses your mailbox only when your agent makes a tool call,
                and only for the specific messages or folders the tool requests.
              </p>

              <h4>5.3 No data brokers or advertising networks</h4>
              <p>
                We do not share any data with data brokers, advertising networks, social
                media platforms, or analytics companies that build user profiles.
              </p>

              <h4>5.4 Legal disclosures</h4>
              <p>
                We may disclose personal data if required by law, valid legal process
                (such as a court order or subpoena), or to protect the rights, property,
                or safety of MCPEmails, our users, or the public. Where permitted by law,
                we will notify affected users before disclosing their data.
              </p>

              <h4>5.5 Business transfers</h4>
              <p>
                In the event of a merger, acquisition, or sale of assets, personal data
                may be transferred as part of that transaction. We will notify users via
                the email address on their account before any such transfer occurs and
                before their data becomes subject to a different privacy policy.
              </p>
            </LegalSection>

            {/* 6 — International transfers */}
            <LegalSection id="international-transfers" title="6. International Data Transfers">
              <p>
                MCPEmails is operated from Norway, which is subject to the European
                Economic Area (EEA) data protection framework. If you access the service
                from outside the EEA, your data may be transferred to and processed in
                countries within the EEA.
              </p>
              <p>
                Our infrastructure sub-processors (Supabase, Vercel) operate under
                Standard Contractual Clauses (SCCs) approved by the European Commission
                for data transfers to third countries. For Stripe, processing is covered
                by their EU-US Data Privacy Framework certification.
              </p>
              <p>
                Enterprise customers can elect to store all account and configuration
                data exclusively in EU-based infrastructure (Frankfurt region) at no
                additional cost.
              </p>
            </LegalSection>

            {/* 7 — Your rights */}
            <LegalSection id="your-rights" title="7. Your Rights">
              <p>
                Depending on your location, you may have the following rights regarding
                your personal data:
              </p>
              <ul>
                <li>
                  <strong>Access.</strong> Request a copy of all personal data we hold
                  about you.
                </li>
                <li>
                  <strong>Rectification.</strong> Ask us to correct inaccurate or
                  incomplete data.
                </li>
                <li>
                  <strong>Erasure ("right to be forgotten").</strong> Request deletion of
                  your personal data. You can trigger this yourself by deleting your
                  account in Dashboard → Settings → Delete Account.
                </li>
                <li>
                  <strong>Restriction.</strong> Ask us to restrict processing of your
                  data in certain circumstances.
                </li>
                <li>
                  <strong>Data portability.</strong> Request your data in a
                  machine-readable format (JSON).
                </li>
                <li>
                  <strong>Objection.</strong> Object to processing based on legitimate
                  interests.
                </li>
                <li>
                  <strong>Withdraw consent.</strong> Where processing is based on consent,
                  withdraw it at any time without affecting the lawfulness of prior
                  processing.
                </li>
              </ul>
              <p>
                To exercise any of these rights, email us at{' '}
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. We will respond
                within 30 days (or 72 hours for urgent security-related requests). We may
                ask you to verify your identity before processing the request.
              </p>
              <p>
                If you are located in the EEA or UK, you have the right to lodge a
                complaint with your local supervisory authority. In Norway, this is the{' '}
                <strong>Datatilsynet</strong> (datatilsynet.no).
              </p>
            </LegalSection>

            {/* 8 — Security */}
            <LegalSection id="security" title="8. Security">
              <p>
                We take the security of your data seriously and implement appropriate
                technical and organisational measures, including:
              </p>
              <ul>
                <li>
                  All data in transit is encrypted using TLS 1.2 or higher. Connections
                  that do not support TLS are rejected.
                </li>
                <li>
                  OAuth tokens and IMAP credentials are encrypted at rest using
                  AES-256-GCM. The encryption key is stored in a separate Supabase Vault
                  instance and is never co-located with the encrypted data.
                </li>
                <li>
                  API keys are hashed with SHA-256 before storage. The raw key cannot be
                  recovered from the hash.
                </li>
                <li>
                  Database access is protected by Row-Level Security (RLS) policies that
                  prevent one workspace from accessing another's data, even in the event
                  of a query logic error.
                </li>
                <li>
                  Administrative access to production infrastructure requires multi-factor
                  authentication and is logged.
                </li>
              </ul>
              <p>
                Despite these measures, no system is perfectly secure. If you discover a
                security vulnerability, please report it responsibly to{' '}
                <a href="mailto:security@mcpemails.com">security@mcpemails.com</a>. We aim
                to acknowledge reports within 24 hours and resolve confirmed vulnerabilities
                within 72 hours for critical issues.
              </p>
              <p>
                In the event of a personal data breach that is likely to result in a risk
                to your rights and freedoms, we will notify affected users and the
                relevant supervisory authority within 72 hours of becoming aware of the
                breach, as required by GDPR Article 33.
              </p>
            </LegalSection>

            {/* 9 — Children */}
            <LegalSection id="children" title="9. Children's Privacy">
              <p>
                MCPEmails is not directed at children under the age of 16. We do not
                knowingly collect personal data from anyone under 16. If you believe we
                have inadvertently collected data from a child, please contact us at{' '}
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will
                delete it promptly.
              </p>
            </LegalSection>

            {/* 10 — Changes */}
            <LegalSection id="changes" title="10. Changes to This Policy">
              <p>
                We may update this Privacy Policy from time to time. When we make material
                changes — such as collecting new categories of data or sharing data with
                new third parties — we will:
              </p>
              <ul>
                <li>Update the "Last updated" date at the top of this page.</li>
                <li>
                  Send an email notification to the address registered on your account at
                  least 14 days before the changes take effect.
                </li>
                <li>
                  Display a prominent notice in the dashboard for 14 days after the change
                  takes effect.
                </li>
              </ul>
              <p>
                Your continued use of the service after a change takes effect constitutes
                acceptance of the updated policy. If you disagree with a material change,
                you may delete your account before the effective date.
              </p>
            </LegalSection>

            {/* 11 — Contact */}
            <LegalSection id="contact" title="11. Contact Us">
              <p>
                If you have questions about this Privacy Policy, wish to exercise a data
                subject right, or want to report a privacy concern, please contact us:
              </p>
              <div className="legal-contact-card">
                <div className="legal-contact-row">
                  <strong>Email</strong>
                  <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
                </div>
                <div className="legal-contact-row">
                  <strong>Security issues</strong>
                  <a href="mailto:security@mcpemails.com">security@mcpemails.com</a>
                </div>
                <div className="legal-contact-row">
                  <strong>Postal address</strong>
                  <span>{COMPANY_NAME}, {COMPANY_ADDRESS}</span>
                </div>
                <div className="legal-contact-row">
                  <strong>Response time</strong>
                  <span>We respond to all privacy requests within 30 days</span>
                </div>
              </div>
            </LegalSection>

          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">Questions about your data?</h2>
          <p className="pricing-cta-sub">
            Our privacy team is here to help. Email us and we will respond within 30 days.
          </p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href={`mailto:${CONTACT_EMAIL}`}>
              Contact privacy team
            </a>
            <a className="btn btn-on-dark btn-lg" href="/terms">
              Read our Terms
            </a>
          </div>
        </div>
      </section>

      <Footer />

      <style>{`
        /* ─── Legal page styles ─────────────────────────────────── */
        .legal-body {
          font-family: var(--font-sans);
          color: var(--fg-1);
          line-height: 1.75;
        }

        .legal-section {
          margin-bottom: 56px;
          padding-bottom: 56px;
          border-bottom: 1px solid var(--border-1);
        }

        .legal-section:last-child {
          border-bottom: none;
          margin-bottom: 0;
          padding-bottom: 0;
        }

        .legal-section h2 {
          font-size: 22px;
          font-weight: 700;
          color: var(--fg-0);
          margin: 0 0 20px;
          scroll-margin-top: 80px;
        }

        .legal-section h4 {
          font-size: 15px;
          font-weight: 650;
          color: var(--fg-0);
          margin: 28px 0 10px;
        }

        .legal-section p {
          font-size: 15px;
          margin: 0 0 16px;
          color: var(--fg-2);
        }

        .legal-section ul {
          margin: 0 0 16px 0;
          padding-left: 20px;
        }

        .legal-section ul li {
          font-size: 15px;
          color: var(--fg-2);
          margin-bottom: 10px;
          line-height: 1.65;
        }

        .legal-section a {
          color: var(--cobalt-600);
          text-decoration: underline;
          text-underline-offset: 2px;
        }

        .legal-section a:hover {
          color: var(--cobalt-700);
        }

        .legal-section code {
          font-family: var(--font-mono);
          font-size: 0.88em;
          background: var(--bg-sunken);
          padding: 1px 5px;
          border-radius: 4px;
          color: var(--fg-1);
        }

        /* ─── Tables ──────────────────────────────────────────── */
        .legal-table-wrap {
          overflow-x: auto;
          margin: 20px 0;
          border: 1px solid var(--border-1);
          border-radius: var(--radius-lg);
        }

        .legal-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
          font-family: var(--font-sans);
        }

        .legal-table th {
          text-align: left;
          padding: 11px 16px;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--fg-3);
          background: var(--bg-sunken);
          border-bottom: 1px solid var(--border-1);
        }

        .legal-table td {
          padding: 12px 16px;
          color: var(--fg-2);
          vertical-align: top;
          border-bottom: 1px solid var(--border-1);
          line-height: 1.55;
        }

        .legal-table tr:last-child td {
          border-bottom: none;
        }

        .legal-table tbody tr:hover {
          background: var(--bg-hover);
        }

        /* ─── Contact card ─────────────────────────────────────── */
        .legal-contact-card {
          border: 1px solid var(--border-1);
          border-radius: var(--radius-lg);
          overflow: hidden;
          margin-top: 20px;
        }

        .legal-contact-row {
          display: flex;
          gap: 24px;
          padding: 14px 20px;
          border-bottom: 1px solid var(--border-1);
          font-size: 14px;
          line-height: 1.5;
        }

        .legal-contact-row:last-child {
          border-bottom: none;
        }

        .legal-contact-row strong {
          min-width: 140px;
          color: var(--fg-1);
          font-weight: 600;
          flex-shrink: 0;
        }

        .legal-contact-row span,
        .legal-contact-row a {
          color: var(--fg-2);
        }

        .legal-contact-row a {
          color: var(--cobalt-600);
          text-decoration: underline;
          text-underline-offset: 2px;
        }

        @media (max-width: 640px) {
          .legal-contact-row {
            flex-direction: column;
            gap: 4px;
          }
          .legal-contact-row strong {
            min-width: unset;
          }
        }
      `}</style>
    </div>
  );
}

/* ─── Helper component ───────────────────────────────────────── */

function LegalSection({ id, title, children }) {
  return (
    <div className="legal-section" id={id}>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
