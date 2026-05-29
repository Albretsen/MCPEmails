/* App.jsx: marketing root. Tweaks expose hero variant + dark mode. */

const { useState, useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "heroVariant": "pipe",
  "dark": false
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Apply dark mode (also persisted so other pages match)
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", t.dark ? "dark" : "light");
    try { localStorage.setItem("mcpe-theme", t.dark ? "dark" : "light"); } catch(e) {}
  }, [t.dark]);

  // Read initial dark state from localStorage on first mount, if user came from another page
  useEffect(() => {
    try {
      const saved = localStorage.getItem("mcpe-theme");
      if (saved === "dark" && !t.dark) setTweak("dark", true);
      if (saved === "light" && t.dark) setTweak("dark", false);
    } catch(e) {}
    // eslint-disable-next-line
  }, []);

  const onSignIn     = () => {};
  const onGetStarted = () => {};

  return (
    <div data-screen-label="Marketing / Home">
      <Nav onSignIn={onSignIn} onGetStarted={onGetStarted} />
      <Hero variant={t.heroVariant} onGetStarted={onGetStarted} />
      <Trusted />
      <Features />
      <HowItWorks />
      <Quote />
      <Pricing onGetStarted={onGetStarted} />
      <Footer />

      <TweaksPanel>
        <TweakSection label="Hero" />
        <TweakRadio
          label="Visual"
          value={t.heroVariant}
          options={[
            { value: "pipe",     label: "Pipe diagram" },
            { value: "endpoint", label: "MCP endpoint" },
            { value: "terminal", label: "Live terminal" },
          ]}
          onChange={(v) => setTweak("heroVariant", v)}
        />
        <TweakSection label="Theme" />
        <TweakToggle label="Dark mode" value={t.dark}
                     onChange={(v) => setTweak("dark", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("app")).render(<App />);
