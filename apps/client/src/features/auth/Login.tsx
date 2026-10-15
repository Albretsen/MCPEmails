import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { AuthFailure, type OAuthProvider, sendMagicLink, signInWithPassword, signInWithProvider, useAuthStore } from "../../auth";
import { PASSWORD_RESET_URL, SIGNUP_URL } from "../../config";
import { cx } from "../../lib/cx";
import { Button, Spinner } from "../../ui";
import s from "./Auth.module.css";

/* The signed-out screen. Accounts are created on mcpemails.com; this only
 * signs in: password, an emailed link, Google or GitHub. */

type Busy = "password" | "link" | OAuthProvider | null;
type Message = { kind: "error" | "ok"; text: string } | null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function reason(err: unknown): string {
  return err instanceof AuthFailure ? err.message : "Could not sign in. Check your connection and try again.";
}

export function LoginScreen() {
  const notice = useAuthStore((a) => a.notice);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<Message>(notice ? { kind: "error", text: notice } : null);
  const [invalid, setInvalid] = useState<"email" | "password" | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const emailId = useId();
  const passwordId = useId();
  const messageId = useId();

  useEffect(() => {
    document.title = "Sign in · mcpemails";
    emailRef.current?.focus();
  }, []);

  const fail = (field: "email" | "password", text: string) => {
    setInvalid(field);
    setMessage({ kind: "error", text });
    (field === "email" ? emailRef : passwordRef).current?.focus();
  };

  const checkEmail = (): string | null => {
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      fail("email", value ? "That does not look like an email address." : "Enter your email address.");
      return null;
    }
    return value;
  };

  const start = (what: Exclude<Busy, null>) => {
    setBusy(what);
    setInvalid(null);
    setMessage(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const address = checkEmail();
    if (!address) return;
    if (!password) return fail("password", "Enter your password, or use a sign-in link instead.");
    start("password");
    try {
      await signInWithPassword(address, password);
    } catch (err) {
      setBusy(null);
      const text = reason(err);
      setMessage({ kind: "error", text });
      if (err instanceof AuthFailure && err.code === "invalid_credentials") {
        setInvalid("password");
        passwordRef.current?.select();
      }
    }
  };

  const onLink = async () => {
    if (busy) return;
    const address = checkEmail();
    if (!address) return;
    start("link");
    try {
      await sendMagicLink(address);
      setMessage({ kind: "ok", text: `Check ${address} for a sign-in link. Open it in this browser.` });
    } catch (err) {
      setMessage({ kind: "error", text: reason(err) });
    }
    setBusy(null);
  };

  const onProvider = async (provider: OAuthProvider) => {
    if (busy) return;
    start(provider);
    try {
      // Leaves the page. Stays busy until the browser navigates.
      await signInWithProvider(provider);
    } catch (err) {
      setBusy(null);
      setMessage({ kind: "error", text: reason(err) });
    }
  };

  const describedBy = message ? messageId : undefined;

  return (
    <div className={s.page}>
      <main className={s.center}>
        <div className={s.brand}>
          <img className={s.wordmark} src="/logo-wordmark.svg" alt="mcpemails" />
        </div>

        <div className={s.card}>
          <h1 className={s.title}>Sign in</h1>

          <form className={s.form} onSubmit={onSubmit} noValidate aria-busy={busy != null || undefined}>
            <div className={s.field}>
              <label className={s.label} htmlFor={emailId}>
                Email
              </label>
              <input
                ref={emailRef}
                id={emailId}
                className={s.input}
                type="email"
                name="email"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                required
                value={email}
                aria-invalid={invalid === "email" || undefined}
                aria-describedby={invalid === "email" ? describedBy : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (invalid === "email") setInvalid(null);
                }}
              />
            </div>

            <div className={s.field}>
              <div className={s.labelRow}>
                <label className={s.label} htmlFor={passwordId}>
                  Password
                </label>
                <a className={s.hintLink} href={PASSWORD_RESET_URL}>
                  Forgot password?
                </a>
              </div>
              <input
                ref={passwordRef}
                id={passwordId}
                className={s.input}
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                aria-invalid={invalid === "password" || undefined}
                aria-describedby={invalid === "password" ? describedBy : undefined}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (invalid === "password") setInvalid(null);
                }}
              />
            </div>

            {/* Always mounted and always two lines tall: nothing below it moves. */}
            <p
              id={messageId}
              className={cx(s.message, message?.kind === "error" && s.error, message?.kind === "ok" && s.ok)}
              role={message?.kind === "error" ? "alert" : "status"}
              aria-live={message?.kind === "error" ? "assertive" : "polite"}
            >
              {message?.text ?? ""}
            </p>

            <Button type="submit" variant="primary" className={s.wide} disabled={busy != null}>
              {busy === "password" ? <Spinner label="Signing in" /> : null}
              Sign in
            </Button>
            <Button className={s.wide} disabled={busy != null} onClick={onLink}>
              {busy === "link" ? <Spinner label="Sending the link" /> : null}
              Email me a sign-in link
            </Button>
          </form>

          <div className={s.divider} role="separator">
            or
          </div>

          <div className={s.providers}>
            <Button className={s.wide} disabled={busy != null} onClick={() => void onProvider("google")}>
              {busy === "google" ? <Spinner label="Opening Google" /> : <GoogleMark />}
              Continue with Google
            </Button>
            <Button className={s.wide} disabled={busy != null} onClick={() => void onProvider("github")}>
              {busy === "github" ? <Spinner label="Opening GitHub" /> : <GitHubMark />}
              Continue with GitHub
            </Button>
          </div>
        </div>

        <p className={s.foot}>
          New to mcpemails? <a href={SIGNUP_URL}>Create an account</a>
        </p>
      </main>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg className={s.providerIcon} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg className={s.providerIcon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 8 0z"
      />
    </svg>
  );
}

export default LoginScreen;
