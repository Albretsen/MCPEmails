import { Nav, Footer } from '../../components/marketing/Sections';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

export const metadata = {
  title: 'Terms of Service',
  description: 'The terms governing your use of MCPEmails — acceptable use, liability, account termination, and governing law.',
  alternates: {
    canonical: `${APP_URL}/terms`,
  },
  openGraph: {
    type: 'website',
    url: `${APP_URL}/terms`,
    title: 'Terms of Service · mcpemails',
    description: 'The terms governing your use of MCPEmails — acceptable use, liability, account termination, and governing law.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'mcpemails Terms of Service',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Terms of Service · mcpemails',
    description: 'The terms governing your use of MCPEmails — acceptable use, liability, and governing law.',
    images: ['/og.png'],
  },
};

/* ─── Constants ──────────────────────────────────────────────── */

const LAST_UPDATED = 'May 25, 2026';
const EFFECTIVE_DATE = 'May 25, 2026';
const CONTACT_EMAIL = 'legal@mcpemails.com';
const COMPANY_NAME = 'MCPEmails';
const COMPANY_ADDRESS = 'Oslo, Norway';

/* ─── Page ───────────────────────────────────────────────────── */

export default function TermsPage() {
  return (
    <div>
      <Nav />

      {/* Hero */}
      <section className="pricing-page-hero" style={{ paddingBottom: 48 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="eye-label">Legal</div>
          <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>
            Terms of Service
          </h1>
          <p className="pricing-page-lead" style={{ maxWidth: 600 }}>
            These terms govern your access to and use of MCPEmails. By creating an account
            or using the service you agree to be bound by them. Please read them carefully.
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

            {/* 1 — Agreement */}
            <LegalSection id="agreement" title="1. Agreement to These Terms">
              <p>
                These Terms of Service ("Terms") constitute a legally binding agreement
                between you ("you" or "User") and {COMPANY_NAME} ("MCPEmails", "we", "us",
                or "our"), governing your access to and use of the MCPEmails service,
                including the website at <strong>mcpemails.com</strong>, the dashboard, the
                Model Context Protocol (MCP) API endpoint, and all related software and
                documentation (collectively, the "Service").
              </p>
              <p>
                By creating an account, accepting these Terms, or using any part of the
                Service, you confirm that you are at least 16 years of age (or the minimum
                age of digital consent in your jurisdiction, if higher), that you have the
                legal capacity to enter into a binding agreement, and that you agree to be
                bound by these Terms and our{' '}
                <a href="/privacy">Privacy Policy</a>, which is incorporated into these
                Terms by reference.
              </p>
              <p>
                If you are accepting these Terms on behalf of a company or other legal
                entity, you represent and warrant that you have the authority to bind that
                entity, in which case "you" refers to that entity.
              </p>
              <p>
                If you do not agree to these Terms, do not create an account or use the
                Service.
              </p>
            </LegalSection>

            {/* 2 — Description of service */}
            <LegalSection id="service-description" title="2. Description of Service">
              <p>
                MCPEmails provides a software-as-a-service platform that allows you to
                connect email accounts (Gmail, Microsoft Outlook, Fastmail, and compatible
                IMAP accounts) and expose those accounts to AI agents via the Model Context
                Protocol (MCP). The Service includes:
              </p>
              <ul>
                <li>
                  A web dashboard for managing connected email accounts, API keys, and
                  usage monitoring.
                </li>
                <li>
                  An MCP-compliant HTTP endpoint that AI agents authenticate against using
                  API keys you generate.
                </li>
                <li>
                  OAuth integration with supported email providers to obtain and manage
                  delegated access to your mailboxes.
                </li>
                <li>
                  A usage and audit log showing which tools your agents have called and when.
                </li>
              </ul>
              <p>
                MCPEmails acts as a protocol bridge. We do not store email content on our
                servers; we retrieve it live from your email provider at the moment an agent
                requests it and return it in the same HTTP response. See our{' '}
                <a href="/privacy">Privacy Policy</a> for a full description of what data we
                do and do not retain.
              </p>
              <p>
                We reserve the right to modify, suspend, or discontinue any part of the
                Service at any time. Where practicable we will give at least 30 days' notice
                of material changes to paid users.
              </p>
            </LegalSection>

            {/* 3 — Account registration */}
            <LegalSection id="account-registration" title="3. Account Registration and Security">

              <h4>3.1 Registration</h4>
              <p>
                You must register for an account to use most features of the Service.
                You agree to provide accurate, current, and complete information during
                registration and to keep that information up to date. Accounts registered
                with false, inaccurate, or misleading information may be suspended or
                terminated without notice.
              </p>

              <h4>3.2 One account per person</h4>
              <p>
                Each account is for the use of one individual or one legal entity. You may
                not share login credentials with other people or create multiple accounts
                to circumvent plan limits or other restrictions.
              </p>

              <h4>3.3 Account security</h4>
              <p>
                You are responsible for maintaining the security of your account credentials,
                including your password and any API keys you generate. You must notify us
                immediately at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> if
                you suspect unauthorised access to your account. MCPEmails is not liable for
                any loss or damage arising from your failure to maintain the security of
                your credentials.
              </p>

              <h4>3.4 API keys</h4>
              <p>
                API keys you generate grant access to the MCP endpoint on your behalf. You
                are solely responsible for all actions taken using keys you have generated,
                including actions taken by AI agents to which you have provided those keys.
                Treat API keys as secrets. Revoke any key that you suspect has been
                compromised.
              </p>
            </LegalSection>

            {/* 4 — Acceptable use */}
            <LegalSection id="acceptable-use" title="4. Acceptable Use">

              <h4>4.1 Permitted use</h4>
              <p>
                You may use the Service for any lawful purpose that is consistent with
                these Terms. Typical permitted uses include connecting your own email
                accounts, generating API keys for AI agents you operate, and building
                applications or workflows for yourself or your organisation.
              </p>

              <h4>4.2 Prohibited conduct</h4>
              <p>
                You must not use the Service, directly or indirectly, for any of the
                following:
              </p>
              <ul>
                <li>
                  <strong>Unauthorised access.</strong> Connecting email accounts that you
                  do not own or are not authorised to access on behalf of the account holder.
                </li>
                <li>
                  <strong>Spam and bulk messaging.</strong> Sending unsolicited commercial
                  email, bulk email, or any message that violates the CAN-SPAM Act, CASL,
                  the EU's ePrivacy Directive, or equivalent laws in your jurisdiction.
                </li>
                <li>
                  <strong>Phishing and fraud.</strong> Sending messages that impersonate
                  another person or organisation, or that are designed to deceive recipients
                  into revealing credentials, financial details, or other sensitive
                  information.
                </li>
                <li>
                  <strong>Malware distribution.</strong> Sending email containing malicious
                  code, ransomware, spyware, or any other software designed to damage or
                  gain unauthorised access to a recipient's device or data.
                </li>
                <li>
                  <strong>Harassment and abuse.</strong> Using the Service to threaten,
                  harass, intimidate, stalk, or harm any individual.
                </li>
                <li>
                  <strong>Illegal content.</strong> Transmitting, storing, or accessing
                  content that is illegal under applicable law, including content that
                  infringes intellectual property rights, violates privacy laws, or
                  constitutes child sexual abuse material (CSAM).
                </li>
                <li>
                  <strong>Circumvention.</strong> Attempting to circumvent authentication,
                  rate limits, access controls, or any other security measure of the
                  Service or of any third-party service (including email providers).
                </li>
                <li>
                  <strong>Reverse engineering.</strong> Attempting to decompile, disassemble,
                  reverse-engineer, or otherwise derive the source code of the Service.
                </li>
                <li>
                  <strong>Interference.</strong> Introducing viruses, denial-of-service
                  attacks, or any other code or action that interferes with the operation of
                  the Service or its infrastructure.
                </li>
                <li>
                  <strong>Reselling without permission.</strong> Reselling or sublicensing
                  access to the Service to third parties without our prior written consent.
                </li>
                <li>
                  <strong>Automated scraping.</strong> Using the Service to scrape or
                  harvest email data at scale for purposes other than your own legitimate
                  agent-driven workflow.
                </li>
              </ul>

              <h4>4.3 Responsibility for agents</h4>
              <p>
                You are responsible for the actions of any AI agent or automated system
                that accesses the Service using an API key you have generated. This
                includes actions that the agent takes autonomously. You must ensure that
                agents operating under your API keys comply with these Terms and with
                applicable law.
              </p>

              <h4>4.4 Compliance with email provider terms</h4>
              <p>
                You must comply with the terms of service and API policies of any email
                provider whose account you connect to MCPEmails (including Google, Microsoft,
                and Fastmail). MCPEmails is not responsible for any suspension or
                restriction of your email account by a third-party provider.
              </p>

              <h4>4.5 Enforcement</h4>
              <p>
                We reserve the right to investigate suspected violations of these rules.
                If we determine, in our sole discretion, that you have violated this
                section, we may suspend or terminate your account, remove or disable
                access to specific API keys or connected inboxes, and report violations
                to law enforcement authorities where required by law or where we deem it
                appropriate to protect others.
              </p>
            </LegalSection>

            {/* 5 — Plans and payment */}
            <LegalSection id="plans-and-payment" title="5. Plans, Fees, and Payment">

              <h4>5.1 Free plan</h4>
              <p>
                The Free plan is provided at no charge and is subject to the usage limits
                described on our <a href="/pricing">Pricing page</a>. We reserve the right
                to change or discontinue the Free plan with 30 days' notice.
              </p>

              <h4>5.2 Paid plans</h4>
              <p>
                Paid plans are billed monthly or annually in advance. By subscribing to a
                paid plan you authorise us to charge the payment method on file at the start
                of each billing period. All fees are exclusive of applicable taxes, which
                will be added where required by law.
              </p>

              <h4>5.3 Upgrades and downgrades</h4>
              <p>
                You may upgrade your plan at any time; the new rate takes effect
                immediately and is prorated for the remainder of the current billing period.
                Downgrading takes effect at the start of the next billing period. Features
                that exceed the new plan's limits will be disabled at the downgrade date.
              </p>

              <h4>5.4 Refunds</h4>
              <p>
                Payments for monthly plans are non-refundable except where required by
                applicable consumer protection law. For annual plans, you may request a
                prorated refund for unused complete months within 14 days of your renewal
                date by contacting us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
              </p>

              <h4>5.5 Late payment and suspension</h4>
              <p>
                If a payment fails, we will retry the charge and notify you by email. If
                payment remains outstanding after 7 days, we may suspend access to paid
                features until the balance is settled. If payment remains outstanding after
                30 days, we may terminate the account in accordance with Section 8.
              </p>

              <h4>5.6 Price changes</h4>
              <p>
                We may change pricing for paid plans with at least 30 days' written notice
                to your registered email address. Price changes will not apply until your
                next renewal date.
              </p>
            </LegalSection>

            {/* 6 — Intellectual property */}
            <LegalSection id="intellectual-property" title="6. Intellectual Property">

              <h4>6.1 MCPEmails IP</h4>
              <p>
                All intellectual property rights in the Service, including the software,
                designs, logos, trademarks, and documentation, are owned by MCPEmails or
                its licensors. Nothing in these Terms grants you any right, title, or
                interest in MCPEmails intellectual property except the limited licence to
                use the Service as described in these Terms.
              </p>

              <h4>6.2 Your data and content</h4>
              <p>
                You retain all rights to your email content and account data. By using the
                Service you grant MCPEmails a limited, non-exclusive, royalty-free licence
                to process and transmit your data solely as necessary to provide the Service.
                We do not acquire ownership of your data, and we will never use your email
                content for purposes other than fulfilling your agent's tool call.
              </p>

              <h4>6.3 Feedback</h4>
              <p>
                If you provide us with feedback, suggestions, or ideas about the Service,
                you grant us an unrestricted, perpetual, irrevocable, royalty-free licence
                to use and incorporate that feedback into the Service without compensation
                or attribution to you.
              </p>
            </LegalSection>

            {/* 7 — Disclaimer and limitation of liability */}
            <LegalSection id="liability" title="7. Disclaimers and Limitation of Liability">

              <h4>7.1 Service provided "as is"</h4>
              <p>
                The Service is provided "as is" and "as available" without warranties of
                any kind, either express or implied, including — but not limited to —
                implied warranties of merchantability, fitness for a particular purpose,
                non-infringement, and uninterrupted or error-free operation. We do not
                warrant that the Service will meet your requirements, that email delivery
                will be reliable or complete, or that defects will be corrected.
              </p>

              <h4>7.2 Third-party services</h4>
              <p>
                The Service integrates with third-party email providers (Google Gmail,
                Microsoft Outlook, Fastmail, IMAP servers). We are not responsible for
                the availability, reliability, or performance of those services, for
                changes to their APIs or OAuth policies, or for any loss of email access
                resulting from a third-party provider's actions.
              </p>

              <h4>7.3 AI agent actions</h4>
              <p>
                MCPEmails is a protocol bridge. We transmit instructions from AI agents
                to your email providers and return results. We are not responsible for
                the content of emails sent, forwarded, or replied to by AI agents acting
                under your API keys, nor for any consequences of autonomous agent actions
                including accidental email deletion, misdirected messages, or data leakage
                resulting from agent logic errors.
              </p>

              <h4>7.4 Limitation of liability</h4>
              <p>
                To the maximum extent permitted by applicable law, in no event will
                MCPEmails, its directors, employees, agents, or suppliers be liable for
                any indirect, incidental, special, consequential, punitive, or exemplary
                damages — including loss of profits, loss of data, loss of goodwill, or
                business interruption — arising out of or in connection with your use of
                or inability to use the Service, even if MCPEmails has been advised of the
                possibility of such damages.
              </p>
              <p>
                To the maximum extent permitted by applicable law, MCPEmails's total
                aggregate liability to you for all claims arising out of or relating to
                these Terms or the Service, whether in contract, tort (including
                negligence), statute, or otherwise, is limited to the greater of:
                (a) the amount you paid to MCPEmails in the 12 months preceding the event
                giving rise to the claim; or (b) USD 100.
              </p>
              <p>
                Some jurisdictions do not allow the exclusion or limitation of certain
                damages. In those jurisdictions, the limitations above apply to the fullest
                extent permitted by law.
              </p>

              <h4>7.5 Indemnification</h4>
              <p>
                You agree to indemnify, defend, and hold harmless MCPEmails and its
                officers, directors, employees, and agents from and against any claims,
                liabilities, damages, losses, costs, and expenses (including reasonable
                legal fees) arising out of or relating to: (a) your use of the Service
                in violation of these Terms or applicable law; (b) any email you or your
                agents send using the Service; (c) your breach of any third-party rights,
                including intellectual property rights or privacy rights; or (d) any
                dispute between you and a third party (including your email recipients).
              </p>
            </LegalSection>

            {/* 8 — Account termination */}
            <LegalSection id="account-termination" title="8. Account Termination">

              <h4>8.1 Termination by you</h4>
              <p>
                You may close your account at any time by navigating to{' '}
                <strong>Dashboard → Settings → Delete Account</strong> and following the
                confirmation steps. Account deletion is permanent. All connected inbox
                configurations, API keys, and audit logs associated with your workspace will
                be deleted within 30 days of the deletion request.
              </p>
              <p>
                If you are on a paid plan, closing your account stops future billing but
                does not entitle you to a refund of any amounts already charged, except as
                described in Section 5.4.
              </p>

              <h4>8.2 Termination by MCPEmails for cause</h4>
              <p>
                We may suspend or terminate your account immediately, without prior notice
                or liability, if:
              </p>
              <ul>
                <li>
                  You violate Section 4 (Acceptable Use) or any other material provision
                  of these Terms.
                </li>
                <li>
                  We are required to do so by law, court order, or regulatory authority.
                </li>
                <li>
                  Your use of the Service poses a risk to the security, integrity, or
                  availability of the Service or to other users.
                </li>
                <li>
                  You provide false, inaccurate, or fraudulent information during
                  registration or at any subsequent time.
                </li>
                <li>
                  Payment for a paid plan remains outstanding for more than 30 days after
                  the due date.
                </li>
              </ul>
              <p>
                Where termination for cause results in the deletion of your account, we
                will not provide a refund for any unused portion of a paid subscription.
              </p>

              <h4>8.3 Termination by MCPEmails for convenience</h4>
              <p>
                We may terminate your account for any reason not covered by Section 8.2
                by providing at least 30 days' written notice to your registered email
                address. In the event of such termination, we will provide a prorated
                refund for any unused portion of a prepaid annual subscription.
              </p>

              <h4>8.4 Suspension</h4>
              <p>
                In lieu of immediate termination we may, at our discretion, temporarily
                suspend your access to the Service while we investigate a suspected
                violation. We will attempt to provide notice of suspension unless doing
                so would prejudice an ongoing investigation or is prohibited by law.
              </p>

              <h4>8.5 Effect of termination</h4>
              <p>
                Upon termination of your account for any reason:
              </p>
              <ul>
                <li>
                  Your right to access and use the Service immediately ceases.
                </li>
                <li>
                  All API keys associated with your account are immediately revoked.
                </li>
                <li>
                  OAuth token grants issued to MCPEmails by your email provider are
                  revoked; your email provider may take up to 24 hours to reflect this.
                </li>
                <li>
                  Your data will be deleted in accordance with our retention schedule
                  described in the Privacy Policy.
                </li>
              </ul>
              <p>
                The following provisions survive termination: Section 6 (Intellectual
                Property), Section 7 (Disclaimers and Limitation of Liability),
                Section 8.5 (Effect of Termination), Section 9 (Governing Law and
                Disputes), and any other provisions that by their nature should survive.
              </p>
            </LegalSection>

            {/* 9 — Governing law */}
            <LegalSection id="governing-law" title="9. Governing Law and Dispute Resolution">

              <h4>9.1 Governing law</h4>
              <p>
                These Terms and any dispute arising out of or in connection with them or
                the Service shall be governed by and construed in accordance with the laws
                of <strong>Norway</strong>, without regard to its conflict-of-law provisions.
                The United Nations Convention on Contracts for the International Sale of
                Goods does not apply.
              </p>

              <h4>9.2 Jurisdiction</h4>
              <p>
                Any legal action or proceeding relating to these Terms or the Service
                shall be brought exclusively in the courts of <strong>Oslo, Norway</strong>.
                You consent to the personal jurisdiction of those courts and waive any
                objection to venue.
              </p>

              <h4>9.3 Consumer rights (EEA/UK)</h4>
              <p>
                Nothing in these Terms affects any statutory rights you may have as a
                consumer under the laws of your country of residence that cannot be
                excluded or limited by contract. If you are a consumer resident in the
                European Union, you may also submit a complaint through the EU Online
                Dispute Resolution platform at{' '}
                <a
                  href="https://ec.europa.eu/consumers/odr"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ec.europa.eu/consumers/odr
                </a>.
              </p>

              <h4>9.4 Informal resolution</h4>
              <p>
                Before initiating any formal legal proceedings, we encourage you to
                contact us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> so
                that we can attempt to resolve the dispute informally. We will respond
                within 14 business days and work in good faith toward a resolution.
              </p>

              <h4>9.5 Class action waiver</h4>
              <p>
                To the extent permitted by applicable law, you agree that any dispute
                resolution proceedings shall be conducted on an individual basis only.
                You waive any right to bring or participate in a class, collective, or
                representative action against MCPEmails.
              </p>
            </LegalSection>

            {/* 10 — General */}
            <LegalSection id="general" title="10. General Provisions">

              <h4>10.1 Entire agreement</h4>
              <p>
                These Terms, together with the Privacy Policy and any supplemental terms
                applicable to specific features or plans, constitute the entire agreement
                between you and MCPEmails relating to the Service and supersede all prior
                agreements, representations, and understandings.
              </p>

              <h4>10.2 Amendments</h4>
              <p>
                We may update these Terms from time to time. When we make material changes
                we will update the "Last updated" date at the top of this page and send
                an email notification to your registered address at least 14 days before
                the changes take effect. Your continued use of the Service after the
                effective date constitutes your acceptance of the revised Terms. If you
                disagree with a material change you may close your account before the
                effective date.
              </p>

              <h4>10.3 Severability</h4>
              <p>
                If any provision of these Terms is found to be invalid, illegal, or
                unenforceable by a court of competent jurisdiction, that provision shall
                be modified to the minimum extent necessary to make it enforceable, and
                the remaining provisions shall continue in full force and effect.
              </p>

              <h4>10.4 Waiver</h4>
              <p>
                Our failure to enforce any right or provision of these Terms shall not
                constitute a waiver of that right or provision. Any waiver must be in
                writing and signed by an authorised representative of MCPEmails.
              </p>

              <h4>10.5 Assignment</h4>
              <p>
                You may not assign or transfer these Terms or any rights or obligations
                under them without our prior written consent. We may assign these Terms
                to an affiliate or in connection with a merger, acquisition, or sale of
                assets, provided that the assignee assumes all obligations under these
                Terms.
              </p>

              <h4>10.6 Force majeure</h4>
              <p>
                MCPEmails is not liable for any delay or failure to perform its obligations
                under these Terms where such delay or failure results from circumstances
                beyond our reasonable control, including natural disasters, government
                actions, internet infrastructure failures, or third-party service outages.
              </p>

              <h4>10.7 Notices</h4>
              <p>
                Notices from MCPEmails to you will be sent to the email address registered
                on your account. Notices from you to MCPEmails should be sent to{' '}
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Notices are deemed
                received 24 hours after being sent, unless the sender receives a delivery
                failure notification.
              </p>

              <h4>10.8 No partnership</h4>
              <p>
                Nothing in these Terms creates a partnership, joint venture, agency,
                franchise, or employment relationship between you and MCPEmails.
              </p>
            </LegalSection>

            {/* 11 — Contact */}
            <LegalSection id="contact" title="11. Contact Us">
              <p>
                If you have questions about these Terms or need to reach our legal team:
              </p>
              <div className="legal-contact-card">
                <div className="legal-contact-row">
                  <strong>Legal enquiries</strong>
                  <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
                </div>
                <div className="legal-contact-row">
                  <strong>Privacy questions</strong>
                  <a href="mailto:privacy@mcpemails.com">privacy@mcpemails.com</a>
                </div>
                <div className="legal-contact-row">
                  <strong>Security reports</strong>
                  <a href="mailto:security@mcpemails.com">security@mcpemails.com</a>
                </div>
                <div className="legal-contact-row">
                  <strong>Postal address</strong>
                  <span>{COMPANY_NAME}, {COMPANY_ADDRESS}</span>
                </div>
                <div className="legal-contact-row">
                  <strong>Response time</strong>
                  <span>We respond to all legal enquiries within 14 business days</span>
                </div>
              </div>
            </LegalSection>

          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">Questions about these Terms?</h2>
          <p className="pricing-cta-sub">
            Our legal team is happy to help. Reach out and we will respond within
            14 business days.
          </p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href={`mailto:${CONTACT_EMAIL}`}>
              Contact legal team
            </a>
            <a className="btn btn-on-dark btn-lg" href="/privacy">
              Read our Privacy Policy
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
          min-width: 160px;
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
