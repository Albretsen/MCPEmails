'use client';

import { useState } from 'react';
import { Btn } from '../Primitives';
import { planDisplayName } from '@/lib/stripe/plans';

/**
 * The /help contact form. Posts JSON to /api/support/tickets.
 *
 * Signed in, the reply address comes from the session on the server, so the
 * email is shown read-only and the context the server will attach is listed in
 * a disclosure. Signed out, the visitor types an address.
 *
 * `website` is a honeypot: off-screen, out of the tab order, ignored by
 * autofill. A person never fills it; the API drops anything that does.
 * `formToken` is the signed render timestamp the server issued with the page.
 *
 * Every string comes from `copy` (src/lib/support/help-content). Error codes
 * map one to one onto `copy.errors`; anything unknown reads as `unknown`.
 */

export const LIMITS = { subject: 150, message: 5000, email: 254 };

const ENDPOINT = '/api/support/tickets';

function fill(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m,
  );
}

function AttachDisclosure({ copy, context }) {
  const a = copy.attach;
  const mailboxes = Array.isArray(context?.mailboxes) ? context.mailboxes : [];
  return (
    <details className="help-attach">
      <summary>{a.summary}</summary>
      <p className="help-muted">{a.intro}</p>
      <ul>
        {context?.workspace_id ? <li>{a.workspace}: {context.workspace_id}</li> : null}
        {context?.plan ? <li data-plan="">{a.plan}: {planDisplayName(context.plan)}</li> : null}
        <li>
          {a.mailboxes}:{' '}
          {mailboxes.length === 0 ? a.noMailboxes : null}
          {mailboxes.length > 0 ? (
            <ul>
              {mailboxes.map((m, i) => (
                <li key={i} data-mailbox="">
                  {[m.service || m.provider, m.host, m.status].filter(Boolean).join(' · ')}
                  {m.last_error_code ? ` · ${fill(a.lastError, { code: m.last_error_code })}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
        {context?.from ? <li>{a.from}: {context.from}</li> : null}
        {context?.provider ? <li>{a.provider}: {context.provider}</li> : null}
        {context?.code ? <li>{a.code}: {context.code}</li> : null}
      </ul>
      <p className="help-muted">{a.never}</p>
    </details>
  );
}

export default function ContactForm({
  copy,
  signedInEmail = null,
  context = null,
  formToken = '',
  initialCategory = 'connect',
  initialSubject = '',
  providerName = null,
  meta = {},
  categories = ['connect', 'client', 'billing', 'bug', 'feature', 'other'],
}) {
  const signedIn = typeof signedInEmail === 'string' && signedInEmail.length > 0;
  const [category, setCategory] = useState(
    categories.includes(initialCategory) ? initialCategory : categories[0],
  );
  const [subject, setSubject] = useState(initialSubject);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // { ref: string | null }

  const errorLine = (code) => copy.errors[code] ?? copy.errors.unknown;

  // Editing any field clears a stale validation or send error.
  const edit = (setter) => (e) => {
    setter(e.target.value);
    if (error) setError(null);
  };

  async function onSubmit(event) {
    event.preventDefault();
    if (sending) return;

    // Cheap checks the server repeats; they only save a round trip.
    if (!subject.trim()) return setError('subject_required');
    if (!message.trim()) return setError('message_required');
    if (!signedIn && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('invalid_email');

    const body = { category, subject: subject.trim(), message: message.trim(), website, formToken };
    if (!signedIn) body.email = email.trim();
    for (const key of ['from', 'provider', 'code']) {
      if (meta?.[key]) body[key] = meta[key];
    }

    setSending(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (res.ok && data?.ok) {
        setDone({ ref: typeof data.ref === 'string' && data.ref ? data.ref : null });
        return;
      }
      const code = typeof data?.error === 'string' && copy.errors[data.error]
        ? data.error
        : res.status === 404 ? 'not_found' : 'unknown';
      setError(code);
    } catch {
      setError('network');
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <div id="contact" className="help-contact">
        <p className="help-success" role="status">
          {done.ref ? fill(copy.success.withRef, { ref: done.ref }) : copy.success.noRef}
        </p>
      </div>
    );
  }

  const f = copy.form;
  return (
    <div id="contact" className="help-contact">
      <form className="help-form" onSubmit={onSubmit} noValidate>
        {providerName ? <p className="help-muted">{fill(f.aboutProvider, { provider: providerName })}</p> : null}

        <div className="help-field">
          <label htmlFor="help-category" className="help-label">{f.category}</label>
          <select
            id="help-category"
            name="category"
            className="help-input"
            value={category}
            onChange={edit(setCategory)}
          >
            {categories.map((c) => (
              <option key={c} value={c}>{copy.categories[c]}</option>
            ))}
          </select>
        </div>

        {signedIn ? (
          <div className="help-field">
            <span className="help-label">{f.emailSignedIn}</span>
            <span className="help-readonly" data-signed-in-email="">{signedInEmail}</span>
          </div>
        ) : (
          <div className="help-field">
            <label htmlFor="help-email" className="help-label">{f.email}</label>
            <input
              id="help-email"
              name="email"
              type="email"
              className="help-input"
              autoComplete="email"
              maxLength={LIMITS.email}
              value={email}
              onChange={edit(setEmail)}
            />
          </div>
        )}

        <div className="help-field">
          <label htmlFor="help-subject" className="help-label">{f.subject}</label>
          <input
            id="help-subject"
            name="subject"
            className="help-input"
            maxLength={LIMITS.subject}
            value={subject}
            onChange={edit(setSubject)}
          />
        </div>

        <div className="help-field">
          <label htmlFor="help-message" className="help-label">{f.message}</label>
          <textarea
            id="help-message"
            name="message"
            className="help-input help-textarea"
            rows={7}
            maxLength={LIMITS.message}
            value={message}
            onChange={edit(setMessage)}
          />
        </div>

        {/* Honeypot: never visible, never focusable, never autofilled. */}
        <div className="help-hp" aria-hidden="true">
          <input
            id="help-website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>
        <input type="hidden" name="formToken" value={formToken} />

        {signedIn ? <AttachDisclosure copy={copy} context={context} /> : null}

        <div className="help-actions">
          <Btn type="submit" variant="primary" busy={sending}>
            {sending ? f.sending : f.submit}
          </Btn>
        </div>
        {error ? <p className="help-error" role="alert" data-error-code={error}>{errorLine(error)}</p> : null}
      </form>
    </div>
  );
}
