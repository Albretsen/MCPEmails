'use client';

import { Fragment, useState } from 'react';
import { Btn } from '../Primitives';

/**
 * The /cancel form: fill in, check and confirm, then a confirmation to keep.
 *
 * Three steps because the law asks for them (§312k BGB, and the withdrawal
 * function of Directive (EU) 2023/2673): the details, a separate confirm
 * button labelled "Cancel now" or "Confirm withdrawal", and a confirmation
 * showing what was received and when, which the customer can print or save.
 * Nothing is sent until the confirm button is pressed.
 *
 * `website` is a honeypot and `formToken` the signed render timestamp, the
 * same pair the /help form uses. `kind` is 'cancel', 'withdraw' (a
 * subscription) or 'withdraw_pass' (the non-renewing 3-month pass, which has
 * no subscription to cancel); the server stores it as given. Every string comes from `copy`
 * (app/[locale]/cancel/content.mjs); error codes map one to one onto
 * `copy.errors`.
 */

export const LIMITS = { name: 100, email: 254, contract: 100, reason: 2000 };

const ENDPOINT = '/api/legal/contract-request';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ['cancel', 'withdraw', 'withdraw_pass'];

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
  const [step, setStep] = useState('edit'); // 'edit' | 'review' | 'done'
  const [kind, setKind] = useState(KINDS.includes(initialKind) ? initialKind : 'cancel');
  const [cancelType, setCancelType] = useState('ordinary');
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
  const withdrawing = kind !== 'cancel';
  const extraordinary = kind === 'cancel' && cancelType === 'extraordinary';
  const kindValue = { cancel: f.kindValueCancel, withdraw: f.kindValueWithdraw, withdraw_pass: f.kindValueWithdrawPass }[kind];
  const doneNext = { cancel: f.doneNextCancel, withdraw: f.doneNextWithdraw, withdraw_pass: f.doneNextWithdrawPass }[kind];

  function onContinue(event) {
    event.preventDefault();
    // The server repeats every check; these only save a round trip.
    if (!name.trim()) return setError('name_required');
    if (!EMAIL_RE.test(email.trim())) return setError('invalid_email');
    if (extraordinary && !reason.trim()) return setError('reason_required');
    setError(null);
    setStep('review');
  }

  async function onConfirm() {
    if (sending) return;
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

  const effective =
    kind === 'cancel' && cancelType === 'ordinary' ? f.effectiveOrdinary : f.effectiveImmediate;
  const summary = [
    [f.labels.kind, kindValue],
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
        <h2>{withdrawing ? f.doneWithdraw : f.doneCancel}</h2>
        {done?.ref ? (
          <>
            <p data-ref={done.ref}>{fillNodes(f.doneRef, { ref: <strong>{done.ref}</strong>, time: formatTime(done.receivedAt, locale) })}</p>
            <Summary rows={summary} />
            <p>{doneNext}</p>
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

  if (step === 'review') {
    return (
      <div className="contract-review">
        <h2>{f.reviewHeading}</h2>
        <p className="help-muted">{f.reviewLead}</p>
        <Summary rows={summary} />
        <div className="help-actions contract-actions">
          <Btn variant="primary" onClick={onConfirm} busy={sending}>
            {sending ? f.sending : withdrawing ? f.submitWithdraw : f.submitCancel}
          </Btn>
          <Btn variant="ghost" onClick={() => setStep('edit')} disabled={sending}>{f.back}</Btn>
        </div>
        {error ? <p className="help-error" role="alert" data-error-code={error}>{errorLine(error)}</p> : null}
      </div>
    );
  }

  return (
    <form className="help-form" onSubmit={onContinue} noValidate>
      <fieldset className="contract-fieldset">
        <legend className="help-label">{f.kindLegend}</legend>
        {[
          ['cancel', f.kindCancel, f.kindCancelHint],
          ['withdraw', f.kindWithdraw, f.kindWithdrawHint],
          ['withdraw_pass', f.kindWithdrawPass, f.kindWithdrawPassHint],
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

      <div className="help-actions">
        <Btn type="submit" variant="primary">{f.continue}</Btn>
      </div>
      {error ? <p className="help-error" role="alert" data-error-code={error}>{errorLine(error)}</p> : null}
    </form>
  );
}
