'use client';

import { Fragment, useState } from 'react';
import { Btn } from '../Primitives';

/**
 * The /cancel form: one page with the details and the final button, then a
 * confirmation to keep.
 *
 * The shape the law asks for (§312k(2) BGB, and the withdrawal function of
 * Directive (EU) 2023/2673): the button in the footer leads straight to this
 * page, which asks for the details and carries the button labelled "Cancel
 * now" or "Confirm withdrawal". No step in between. The done screen shows what
 * was received and when, which the customer can print or save. Nothing is
 * sent until that button is pressed.
 *
 * An ordinary cancellation may name a later effective date (§312k(2) Nr. 1);
 * the default is the earliest possible date.
 *
 * `website` is a honeypot and `formToken` the signed render timestamp, the
 * same pair the /help form uses. Every string comes from `copy`
 * (app/[locale]/cancel/content.mjs); error codes map one to one onto
 * `copy.errors`.
 */

export const LIMITS = { name: 100, email: 254, contract: 100, reason: 2000 };

const ENDPOINT = '/api/legal/contract-request';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Mirrors EFFECTIVE_DATE_MAX_DAYS in src/lib/legal/contract-request.ts. */
const MAX_DAYS_AHEAD = 5 * 366;

/** YYYY-MM-DD in the visitor's own time zone, `days` from today. */
function localDate(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(ymd, locale) {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));
  } catch {
    return ymd;
  }
}

function fillNodes(template, values) {
  return String(template ?? '')
    .split(/(\{\w+\})/)
    .map((part, i) => {
      const key = part.startsWith('{') && part.endsWith('}') ? part.slice(1, -1) : null;
      return <Fragment key={i}>{key && key in values ? values[key] : part}</Fragment>;
    });
}

function formatTime(iso, locale) {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZoneName: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function Summary({ rows }) {
  return (
    <dl className="contract-summary">
      {rows.map(([label, value]) => (
        <div key={label} className="contract-summary-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function CancelForm({ copy, locale = 'en', initialKind = 'cancel', formToken = '', supportEmail }) {
  const f = copy.form;
  const [step, setStep] = useState('edit'); // 'edit' | 'done'
  const [kind, setKind] = useState(initialKind === 'withdraw' ? 'withdraw' : 'cancel');
  const [cancelType, setCancelType] = useState('ordinary');
  const [when, setWhen] = useState('earliest'); // 'earliest' | 'date'
  const [effectiveDate, setEffectiveDate] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [contract, setContract] = useState('');
  const [reason, setReason] = useState('');
  const [website, setWebsite] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // { ref, receivedAt }

  const support = <a href={`mailto:${supportEmail}`}>{supportEmail}</a>;
  const errorLine = (code) => fillNodes(copy.errors[code] ?? copy.errors.unknown, { support });
  const extraordinary = kind === 'cancel' && cancelType === 'extraordinary';
  const ordinary = kind === 'cancel' && cancelType === 'ordinary';
  const datedOrdinary = ordinary && when === 'date';

  async function onSubmit(event) {
    event.preventDefault();
    if (sending) return;
    // The server repeats every check; these only save a round trip.
    if (!name.trim()) return setError('name_required');
    if (!EMAIL_RE.test(email.trim())) return setError('invalid_email');
    if (datedOrdinary && (!DATE_RE.test(effectiveDate) || effectiveDate < localDate() || effectiveDate > localDate(MAX_DAYS_AHEAD))) {
      return setError('invalid_effective_date');
    }
    if (extraordinary && !reason.trim()) return setError('reason_required');

    const body = {
      kind,
      name: name.trim(),
      email: email.trim(),
      contract: contract.trim(),
      locale,
      website,
      formToken,
    };
    if (kind === 'cancel') body.cancelType = cancelType;
    if (extraordinary) body.reason = reason.trim();
    if (datedOrdinary) body.effectiveDate = effectiveDate;

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
        setDone({ ref: data.ref ?? null, receivedAt: data.receivedAt ?? null });
        setStep('done');
        return;
      }
      setError(typeof data?.error === 'string' && copy.errors[data.error] ? data.error : 'unknown');
    } catch {
      setError('network');
    } finally {
      setSending(false);
    }
  }

  const effective = !ordinary
    ? f.effectiveImmediate
    : datedOrdinary
      ? f.effectiveOnDate.replace('{date}', formatDate(effectiveDate, locale))
      : f.effectiveOrdinary;
  const summary = [
    [f.labels.kind, kind === 'withdraw' ? f.kindValueWithdraw : f.kindValueCancel],
    ...(kind === 'cancel'
      ? [[f.labels.type, cancelType === 'extraordinary' ? f.typeValueExtraordinary : f.typeValueOrdinary]]
      : []),
    [f.labels.effective, effective],
    [f.labels.name, name.trim()],
    [f.labels.email, email.trim()],
    [f.labels.contract, contract.trim() || f.none],
    ...(extraordinary ? [[f.labels.reason, reason.trim()]] : []),
  ];

  if (step === 'done') {
    return (
      <div className="contract-done" role="status">
        <h2>{kind === 'withdraw' ? f.doneWithdraw : f.doneCancel}</h2>
        {done?.ref ? (
          <>
            <p data-ref={done.ref}>{fillNodes(f.doneRef, { ref: <strong>{done.ref}</strong>, time: formatTime(done.receivedAt, locale) })}</p>
            <Summary rows={summary} />
            <p>{kind === 'withdraw' ? f.doneNextWithdraw : f.doneNextCancel}</p>
            <p className="help-muted">{fillNodes(f.doneEmail, { email: email.trim(), support })}</p>
            <div className="help-actions contract-print">
              <Btn variant="secondary" onClick={() => window.print()}>{f.print}</Btn>
            </div>
          </>
        ) : (
          <p>{f.doneNoRef}</p>
        )}
      </div>
    );
  }

  return (
    <form className="help-form" onSubmit={onSubmit} noValidate>
      <fieldset className="contract-fieldset">
        <legend className="help-label">{f.kindLegend}</legend>
        {[
          ['cancel', f.kindCancel, f.kindCancelHint],
          ['withdraw', f.kindWithdraw, f.kindWithdrawHint],
        ].map(([value, label, hint]) => (
          <label key={value} className="contract-choice">
            <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} />
            <span>
              <span className="contract-choice-label">{label}</span>
              <span className="help-muted contract-choice-hint">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="help-field">
        <label htmlFor="cancel-name" className="help-label">{f.name}</label>
        <input id="cancel-name" name="name" className="help-input" autoComplete="name" maxLength={LIMITS.name} value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="help-field">
        <label htmlFor="cancel-email" className="help-label">{f.email}</label>
        <input id="cancel-email" name="email" type="email" className="help-input" autoComplete="email" maxLength={LIMITS.email} value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>

      <div className="help-field">
        <label htmlFor="cancel-contract" className="help-label">{f.contract}</label>
        <input id="cancel-contract" name="contract" className="help-input" maxLength={LIMITS.contract} value={contract} onChange={(e) => setContract(e.target.value)} />
        <p className="help-muted">{f.contractHint}</p>
      </div>

      {kind === 'cancel' ? (
        <fieldset className="contract-fieldset">
          <legend className="help-label">{f.typeLegend}</legend>
          {[
            ['ordinary', f.typeOrdinary],
            ['extraordinary', f.typeExtraordinary],
          ].map(([value, label]) => (
            <label key={value} className="contract-choice">
              <input type="radio" name="cancelType" value={value} checked={cancelType === value} onChange={() => setCancelType(value)} />
              <span className="contract-choice-label">{label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {ordinary ? (
        <fieldset className="contract-fieldset">
          <legend className="help-label">{f.whenLegend}</legend>
          {[
            ['earliest', f.whenEarliest],
            ['date', f.whenLater],
          ].map(([value, label]) => (
            <label key={value} className="contract-choice">
              <input type="radio" name="when" value={value} checked={when === value} onChange={() => setWhen(value)} />
              <span className="contract-choice-label">{label}</span>
            </label>
          ))}
          {when === 'date' ? (
            <div className="help-field contract-date">
              <label htmlFor="cancel-effective-date" className="help-label">{f.whenDate}</label>
              <input
                id="cancel-effective-date"
                name="effectiveDate"
                type="date"
                className="help-input"
                min={localDate()}
                max={localDate(MAX_DAYS_AHEAD)}
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {extraordinary ? (
        <div className="help-field">
          <label htmlFor="cancel-reason" className="help-label">{f.reason}</label>
          <textarea id="cancel-reason" name="reason" className="help-input help-textarea" rows={5} maxLength={LIMITS.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      ) : null}

      {/* Honeypot: never visible, never focusable, never autofilled. */}
      <div className="help-hp" aria-hidden="true">
        <input id="cancel-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>

      <div className="help-actions contract-actions">
        <Btn type="submit" variant="primary" busy={sending}>
          {sending ? f.sending : kind === 'withdraw' ? f.submitWithdraw : f.submitCancel}
        </Btn>
      </div>
      {error ? <p className="help-error" role="alert" data-error-code={error}>{errorLine(error)}</p> : null}
    </form>
  );
}
