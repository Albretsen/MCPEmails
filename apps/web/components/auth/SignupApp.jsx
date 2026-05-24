'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MIcon, MBtn } from '../MarketingPrimitives';

function readQuery(searchParams, key) {
  return searchParams?.get(key) || null;
}

function ThemeBtn() {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark"); }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem("mcpe-theme", dark ? "dark" : "light"); } catch(e) {}
  }, [dark]);
  return (
    <button className="theme-toggle" onClick={() => setDark(d => !d)} title="Toggle theme">
      <MIcon name={dark ? "sun" : "moon"} size={16} color="currentColor"/>
    </button>
  );
}

export function SignupApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode = readQuery(searchParams, "mode") === "signin" ? "signin" : "signup";
  const [mode, setMode] = useState(initialMode);
  const [step, setStep] = useState("form");      // form → verifying
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [errors, setErrors] = useState({});

  const submit = (e) => {
    e?.preventDefault();
    const errs = {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errs.email = "Enter a valid email.";
    if (!password || password.length < 8)                    errs.password = "8+ characters.";
    if (mode === "signup" && !workspace)                     errs.workspace = "Pick a workspace name.";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setStep("verifying");
    setTimeout(() => {
      const path = mode === "signup" ? "/dashboard?firstrun=1" : "/dashboard";
      router.push(path);
    }, 1100);
  };

  const onOAuth = (provider) => {
    setStep("verifying");
    setTimeout(() => {
      const path = mode === "signup" ? "/dashboard?firstrun=1" : "/dashboard";
      router.push(path);
    }, 900);
  };

  return (
    <div className="auth-shell" data-screen-label={"Auth / " + (mode === "signup" ? "Sign up" : "Sign in")}>
      <ThemeBtn/>
      <div className="auth-wrap">
        <a className="auth-back" href="/">
          <MIcon name="arrow" size={14} color="currentColor" strokeWidth={2}/>
          Back to home
        </a>
        <div className="auth-brand">
          <img src="/logo-wordmark.svg" alt="mcpemails"/>
        </div>

        {step === "form" && (
          <div className="auth-card">
            <h1>{mode === "signup" ? "Create your workspace" : "Sign in"}</h1>
            <p className="sub">
              {mode === "signup"
                ? "Connect an inbox in under a minute. No card required."
                : "Welcome back. Pick up where you left off."}
            </p>

            <div className="auth-providers">
              <button className="auth-prov-btn" onClick={() => onOAuth("google")}>
                <MIcon name="google" size={18}/>
                Continue with Google
              </button>
              <button className="auth-prov-btn" onClick={() => onOAuth("github")}>
                <MIcon name="github" size={18} color="currentColor"/>
                Continue with GitHub
              </button>
            </div>

            <div className="auth-divider">or with email</div>

            <form className="auth-fields" onSubmit={submit} noValidate>
              <div className="field">
                <label>Work email</label>
                <input className={"input" + (errors.email ? " err" : "")} type="email" placeholder="you@company.com"
                       value={email} onChange={e => { setEmail(e.target.value); setErrors(s => ({...s, email: undefined})); }}/>
                {errors.email && <div className="err-msg">{errors.email}</div>}
              </div>
              <div className="field">
                <label>{mode === "signup" ? "Password" : "Password"}</label>
                <input className={"input" + (errors.password ? " err" : "")} type="password" placeholder="••••••••"
                       value={password} onChange={e => { setPassword(e.target.value); setErrors(s => ({...s, password: undefined})); }}/>
                {errors.password && <div className="err-msg">{errors.password}</div>}
              </div>
              {mode === "signup" && (
                <div className="field">
                  <label>Workspace name</label>
                  <input className={"input mono" + (errors.workspace ? " err" : "")} placeholder="jordan-personal"
                         value={workspace} onChange={e => { setWorkspace(e.target.value); setErrors(s => ({...s, workspace: undefined})); }}/>
                  {errors.workspace && <div className="err-msg">{errors.workspace}</div>}
                  <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--fg-3)" }}>
                    Used in URLs like <code className="t-code-inline">{(workspace || "your-workspace") + ".mcpemails.com"}</code>
                  </span>
                </div>
              )}

              <MBtn variant="primary" className="auth-submit" type="submit" onClick={submit}>
                {mode === "signup" ? "Create workspace" : "Sign in"}
              </MBtn>
            </form>

            <div className="auth-footer">
              {mode === "signup" ? (
                <>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); setMode("signin"); setErrors({}); }}>Sign in</a></>
              ) : (
                <>New here? <a href="#" onClick={(e) => { e.preventDefault(); setMode("signup"); setErrors({}); }}>Create a workspace</a></>
              )}
            </div>
          </div>
        )}

        {step === "verifying" && (
          <div className="auth-card" style={{ textAlign: "center", padding: "48px 32px" }}>
            <div style={{ width: 48, height: 48, borderRadius: 999, background: "var(--cobalt-50)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
              <Spinner/>
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 6px" }}>{mode === "signup" ? "Creating your workspace…" : "Signing you in…"}</h1>
            <p className="sub" style={{ margin: 0 }}>This takes a moment. We're provisioning your encrypted credential store in {readQuery(searchParams, "region") === "us" ? "N. Virginia" : "Frankfurt"}.</p>
          </div>
        )}

        {step === "form" && (
          <div className="auth-microcopy">
            <MIcon name="shield" size={13} color="var(--mint-600)"/>
            We never store your email content. SOC 2 in progress. GDPR-friendly.
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="var(--cobalt-200)" strokeWidth="3"/>
      <path d="M12 3a9 9 0 0 1 9 9" stroke="var(--cobalt-500)" strokeWidth="3" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/>
      </path>
    </svg>
  );
}
