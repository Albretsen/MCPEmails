'use client';

import Link from 'next/link';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { parseUploadFragment, UPLOAD_MAX_BYTES } from './target.mjs';

/**
 * Reads the link's fragment, takes one file (picker or drop), and PUTs it
 * straight to the signed upload URL in our Supabase storage. The bytes never
 * pass through mcpemails.com or the chat.
 *
 * States: invalid (no usable link), expired, ready, uploading, done, used
 * (the slot already holds a file: storage answers 409), error.
 */
function subscribeToHash(onChange) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function readHash() {
  return window.location.hash;
}

export default function UploadClient({ copy, supabaseOrigin }) {
  const hash = useSyncExternalStore(subscribeToHash, readHash, () => null);
  const target = useMemo(() => (hash === null ? null : parseUploadFragment(hash, supabaseOrigin)), [hash, supabaseOrigin]);
  // What the upload itself has come to; null until a file is sent.
  const [phase, setPhase] = useState(null);
  const [note, setNote] = useState(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef(null);

  // Expiry is checked when the page opens and again before a send.
  const [openedAt] = useState(() => Date.now());
  const state = phase ?? (hash === null
    ? 'loading'
    : !target
      ? 'invalid'
      : target.expiresAt && Date.parse(target.expiresAt) <= openedAt
        ? 'expired'
        : 'ready');
  const setState = setPhase;

  async function send(file) {
    if (!target || state === 'uploading') return;
    setNote(null);
    if (file.size > UPLOAD_MAX_BYTES) {
      setNote(copy.tooBig);
      return;
    }
    if (target.expiresAt && Date.parse(target.expiresAt) <= Date.now()) {
      setState('expired');
      return;
    }
    setState('uploading');
    try {
      const res = await fetch(target.putUrl, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type || 'application/octet-stream' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (res.ok) setState('done');
      else if (res.status === 409 || res.status === 400) {
        const body = await res.json().catch(() => null);
        if (body && (body.statusCode === '409' || body.error === 'Duplicate')) setState('used');
        else if (body && /expired|signature/i.test(String(body.message ?? ''))) setState('expired');
        else setState('error');
      } else if (res.status === 401 || res.status === 403) setState('expired');
      else setState('error');
    } catch {
      setState('error');
    }
  }

  const banner = {
    invalid: ['warn', copy.invalidTitle, copy.invalidBody],
    expired: ['warn', copy.expiredTitle, copy.expiredBody],
    used: ['warn', copy.usedTitle, copy.usedBody],
    error: ['warn', copy.errorTitle, copy.errorBody],
    done: ['good', copy.doneTitle, copy.doneBody],
  }[state];
  const canPick = state === 'ready' || state === 'error';

  return (
    <div className="review-shell">
      <div className="review-wrap">
        <Link className="review-brand" href="/">
          <img className="logo-light" src="/logo-wordmark.svg" width="280" height="48" alt="MCPEmails" /><img className="logo-dark" src="/logo-wordmark-dark.svg" width="280" height="48" alt="MCPEmails" />
        </Link>
        <div className="card review-card review-card-narrow">
          <div className="review-head">
            <h1>{copy.title}</h1>
            {target && target.filename ? <p className="sub">{copy.asked.replace('{name}', target.filename)}</p> : null}
          </div>
          {banner ? (
            <div className={`review-banner review-banner-${banner[0]}`} role="status" aria-live="polite">
              <div>
                <strong>{banner[1]}</strong>
                <p>{banner[2]}</p>
              </div>
            </div>
          ) : null}
          {canPick ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) send(file);
              }}
              style={{
                border: '1.5px dashed var(--border-strong, var(--ink-200))',
                borderRadius: 12,
                padding: 28,
                textAlign: 'center',
                background: dragging ? 'var(--ink-50)' : 'transparent',
                marginTop: banner ? 16 : 0,
              }}
            >
              <button type="button" className="btn btn-primary" onClick={() => picker.current?.click()}>
                {copy.choose}
              </button>
              <p className="review-hint" style={{ marginTop: 10 }}>{copy.drop}</p>
              <input
                ref={picker}
                type="file"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) send(file);
                }}
              />
            </div>
          ) : null}
          {state === 'uploading' ? <p role="status" aria-live="polite">{copy.uploading}</p> : null}
          {note ? <p className="review-hint" role="alert" style={{ marginTop: 12 }}>{note}</p> : null}
          {canPick ? <p className="review-hint" style={{ marginTop: 12 }}>{copy.once}</p> : null}
        </div>
      </div>
    </div>
  );
}
