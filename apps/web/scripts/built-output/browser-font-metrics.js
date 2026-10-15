// Browser-level font measurement. NOT run by `npm test`: it needs a real
// browser with the page loaded. Paste it into the console (or a browser
// automation tool) on a page served by `next start`, once per page and
// viewport, and compare the result with fixtures/browser-font-metrics.json.
//
// For the light and then the dark theme it records, after every font has
// finished loading:
//   - for a fixed list of selectors, the FIRST matching element's computed
//     font-family, weight, style, size, line-height and its box (w x h);
//   - for EVERY element that directly contains text, a count per distinct
//     (family | weight | style | size | line-height) and the summed box sizes,
//     which catches a face or metric change anywhere on the page;
//   - the page's scroll size (a font swap that reflows shows up here);
//   - the faces document.fonts reports as loaded.
//
// The theme is forced through the data-theme attribute rather than through
// localStorage, because the home page writes its own initial theme back on
// mount. Family stacks are abbreviated: S, M and D are the --font-sans,
// --font-mono and --font-display stacks exactly as colors_and_type.css
// declares them; anything else is reported verbatim.
//
// The measurement is deliberately independent of how the fonts are delivered,
// so the same numbers must come out before and after a delivery change.
(async () => {
  const STACKS = {
    'Geist, ui-sans-serif, -apple-system, "Segoe UI", sans-serif': 'S',
    '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace': 'M',
    '"Instrument Serif", "Iowan Old Style", Georgia, serif': 'D',
  };
  const SELECTORS = [
    'body', 'h1', 'h2', 'h3', 'p', 'nav a', '.btn-primary', '.btn-secondary', '.btn', 'button',
    'input', 'label', 'code', 'pre', '.t-display-italic', 'h1 em', 'footer a', '.auth-card h1',
    '.auth-card .sub', '.auth-back', 'li', 'td', 'th', 'small', 'summary',
  ];
  const round = (n) => Math.round(n * 100) / 100;
  const describe = (el) => {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return [STACKS[cs.fontFamily] || cs.fontFamily, cs.fontWeight, cs.fontStyle, cs.fontSize, cs.lineHeight, round(box.width), round(box.height)];
  };
  const settle = async () => {
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 700));
    await document.fonts.ready;
  };

  const out = { page: location.pathname, viewport: `${innerWidth}x${innerHeight}` };
  await settle();
  for (const theme of ['light', 'dark']) {
    document.documentElement.setAttribute('data-theme', theme);
    await settle();
    const fixed = {};
    for (const selector of SELECTORS) {
      const el = document.querySelector(selector);
      if (el) fixed[selector] = describe(el).join(' ');
    }
    const signatures = {};
    let sumW = 0;
    let sumH = 0;
    let textElements = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
      const hasText = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
      if (!hasText) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const [family, weight, style, size, lineHeight, w, h] = describe(el);
      const key = [family, weight, style, size, lineHeight].join(' ');
      signatures[key] = (signatures[key] || 0) + 1;
      sumW += w;
      sumH += h;
      textElements += 1;
    }
    out[theme] = {
      background: getComputedStyle(document.body).backgroundColor,
      scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      fixed,
      textElements,
      sumW: round(sumW),
      sumH: round(sumH),
      signatures,
      loadedFaces: [...document.fonts]
        .filter((face) => face.status === 'loaded')
        .map((face) => `${face.family.replace(/["']/g, '')} ${face.weight} ${face.style} ${face.unicodeRange.split(',')[0]}`)
        .sort(),
    };
  }
  return out;
})();
