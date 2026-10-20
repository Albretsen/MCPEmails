'use client';

import { useState } from 'react';
import { lookupMailSettings } from '@/lib/tools/settings-lookup.ts';
import { withReadingLang } from '@/i18n/reading-lang.mjs';
import RichText from './RichText';

/*
 * The form and result card of /tools/email-settings-lookup.
 *
 * `t` is the `tool` block of src/lib/tools/email-settings-lookup/<locale>.json,
 * `registry` the released providers (slug, name, domain, status, hosts,
 * locales) built by the page on the server, so providers.mjs never ships in
 * this bundle. All lookups run here, in the browser: see settings-lookup.ts
 * for where the requests go and why.
 */

const fill = (s, vars) => String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));

function ServerRows({ t, server }) {
  return (
    <dl className="tool-settings">
      <div><dt>{t.server}</dt><dd><code className="t-code-inline">{server.host}</code></dd></div>
      <div><dt>{t.port}</dt><dd><code className="t-code-inline">{server.port}</code></dd></div>
      <div><dt>{t.security}</dt><dd>{server.security === 'tls' ? t.securityTls : t.securityStarttls}</dd></div>
      <div><dt>{t.username}</dt><dd>{t.usernameValue}</dd></div>
    </dl>
  );
}

function MxList({ t, domain, mx }) {
  if (!mx.length) return null;
  return (
    <div className="tool-mx">
      <h3>{fill(t.mxTitle, { domain })}</h3>
      <ul>
        {mx.map((host) => <li key={host}><code className="t-code-inline">{host}</code></li>)}
      </ul>
      <p>{t.mxNote}</p>
    </div>
  );
}

export default function EmailSettingsLookup({ t, registry, locale, appPasswordHref }) {
  const [value, setValue] = useState('');
  const [state, setState] = useState({ status: 'idle', result: null });

  /** /connect/<slug> in this locale when the page exists in it, else English. */
  const connectHref = (slug) => {
    const entry = registry.find((p) => p.slug === slug);
    const localized = locale !== 'en' && entry?.locales.includes(locale);
    return `${localized ? `/${locale}` : ''}/connect/${slug}`;
  };
  const signupHref = (slug) => withReadingLang(`/signup?provider=${slug}`, locale);
  const nameOf = (slug) => registry.find((p) => p.slug === slug)?.name ?? slug;

  async function run(input) {
    setState({ status: 'loading', result: null });
    const result = await lookupMailSettings(input, {
      registry,
      fetch: (url, init) => window.fetch(url, init),
    });
    setState({ status: 'done', result });
  }

  function onSubmit(event) {
    event.preventDefault();
    if (state.status === 'loading') return;
    run(value);
  }

  function tryExample(example) {
    setValue(example);
    run(example);
  }

  const r = state.result;

  return (
    <div className="tool-card">
      <form className="tool-form" onSubmit={onSubmit} noValidate>
        <label className="tool-label" htmlFor="settings-lookup-input">{t.label}</label>
        <div className="tool-row">
          <input
            id="settings-lookup-input"
            className="tool-input"
            type="text"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={state.status === 'loading' || !value.trim()}>
            {t.submit}
          </button>
        </div>
        <p className="tool-examples">
          <span>{t.examplesLabel}</span>
          {t.examples.map((ex) => (
            <button key={ex} type="button" className="tool-example" onClick={() => tryExample(ex)}>{ex}</button>
          ))}
        </p>
        <p className="tool-privacy">{t.privacy}</p>
      </form>

      <div className="tool-result" aria-live="polite">
        {state.status === 'loading' && <p className="tool-status">{t.checking}</p>}

        {r?.kind === 'invalid' && <p className="tool-error">{t.invalid}</p>}

        {r?.kind === 'found' && (
          <>
            <p className="tool-provider">
              <span>{t.provider}: </span>
              <strong>{r.label || t.providerUnknown}</strong>
            </p>
            <div className="tool-grid">
              <section>
                <h3>{t.incoming}</h3>
                <ServerRows t={t} server={r.imap} />
              </section>
              <section>
                <h3>{t.outgoing}</h3>
                <ServerRows t={t} server={r.smtp} />
              </section>
            </div>
            <p className="tool-source">{fill(t.source[r.source], { domain: r.domain, provider: r.label || r.mx[0] || '' })}</p>
            {r.requiresAppPassword ? (
              <p className="tool-note">
                {fill(t.appPassword, { provider: r.label })}{' '}
                {r.appPasswordHelpUrl && (
                  <a href={r.appPasswordHelpUrl} rel="nofollow noopener noreferrer" target="_blank">{t.appPasswordCreate}</a>
                )}
                {r.appPasswordHelpUrl && ' · '}
                <a href={appPasswordHref}>{t.appPasswordLearn}</a>
              </p>
            ) : (
              <p className="tool-note">
                {t.appPasswordGeneric} <a href={appPasswordHref}>{t.appPasswordLearn}</a>
              </p>
            )}
            <MxList t={t} domain={r.domain} mx={r.mx} />
            <div className="tool-cta">
              <h3>{t.ctaTitle}</h3>
              <p>{r.slug ? fill(t.ctaBody, { provider: r.label || nameOf(r.slug) }) : t.ctaBodyGeneric}</p>
              <div className="tool-cta-row">
                <a className="btn btn-primary" href={signupHref(r.slug ?? 'imap')}>
                  {r.slug ? fill(t.ctaButton, { provider: nameOf(r.slug) }) : t.ctaButtonGeneric}
                </a>
                <a className="tool-link" href={connectHref(r.slug ?? 'imap')}>
                  {fill(t.guideLink, { provider: nameOf(r.slug ?? 'imap') })}
                </a>
              </div>
            </div>
          </>
        )}

        {r?.kind === 'microsoft' && (
          <>
            <p className="tool-provider"><span>{t.provider}: </span><strong>{nameOf(r.slug)}</strong></p>
            <p className="tool-note">
              {r.slug === 'outlook' ? t.microsoftOutlook : fill(t.microsoftOffice365, { domain: r.domain })}
            </p>
            <MxList t={t} domain={r.domain} mx={r.mx} />
            <div className="tool-cta-row">
              <a className="btn btn-primary" href={signupHref(r.slug)}>{t.microsoftCta}</a>
              <a className="tool-link" href={connectHref(r.slug)}>{fill(t.guideLink, { provider: nameOf(r.slug) })}</a>
            </div>
          </>
        )}

        {r?.kind === 'limited' && (
          <>
            <p className="tool-provider"><span>{t.provider}: </span><strong>{r.label}</strong></p>
            <p className="tool-note">{fill(t.limited, { provider: r.label })}</p>
            <MxList t={t} domain={r.domain} mx={r.mx} />
            <a className="tool-link" href={connectHref(r.slug)}>{fill(t.limitedLink, { provider: r.label })}</a>
          </>
        )}

        {r?.kind === 'notFound' && (
          <>
            <p className="tool-note">
              <RichText>
                {r.mx.length
                  ? `${fill(t.notFound, { domain: r.domain })} ${t.notFoundMx}`
                  : r.dnsFailed
                    ? fill(t.dnsFailed, { domain: r.domain })
                    : fill(t.notFoundNoMx, { domain: r.domain })}
              </RichText>
            </p>
            <MxList t={t} domain={r.domain} mx={r.mx} />
            <div className="tool-cta-row">
              <a className="tool-link" href={connectHref('imap')}>{fill(t.guideLink, { provider: nameOf('imap') })}</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
