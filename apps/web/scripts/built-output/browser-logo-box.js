// Browser-level check that the wordmark's box is reserved before the image
// arrives. NOT run by `npm test` or `npm run check:built-output`: it needs a
// real browser on a page served by `next start`. Paste it into the console (or
// a browser automation tool) once per page and viewport, and compare with
// fixtures/browser-logo-box.json.
//
// For the light and then the dark theme it does two things.
//
// 1. LOADED. Records the bounding box of the visible wordmark <img> and of its
//    neighbours (the nav links, the nav call-to-action buttons, the hamburger,
//    or on the auth screens the back link and the card).
//
// 2. ARRIVAL. Replaces the wordmark with a fresh <img> pointing at a URL the
//    browser has never fetched, which puts it in exactly the state it is in on
//    a cold load before the logo arrives. It measures the same boxes at once
//    (image not there yet) and again after the image's load event, and counts
//    every layout-shift entry the browser reports in between. With the box
//    reserved, the two sets of boxes are equal and the shift is 0.
(async () => {
  const NEIGHBOURS = ['.nav .nav-links', '.nav .nav-cta', '.nav .nav-hamburger', '.nav .btn-primary', '.auth-back', '.auth-card', 'h1'];
  const round = (n) => Math.round(n * 100) / 100;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return [round(r.x), round(r.y), round(r.width), round(r.height)].join(' ');
  };
  const visibleLogo = () => [...document.querySelectorAll('img.logo-light, img.logo-dark')].find((img) => getComputedStyle(img).display !== 'none');
  const snapshot = () => {
    const out = { logo: box(visibleLogo()) };
    for (const selector of NEIGHBOURS) {
      const el = document.querySelector(selector);
      if (el) out[selector] = box(el);
    }
    return out;
  };
  // A few frames, or a short wait where frames do not run (a hidden tab). In a
  // hidden tab the browser reports no layout-shift entries at all, so there
  // `layoutShift` is always 0 and only the before/after boxes are evidence;
  // `tabVisible` records which case a result came from.
  const frames = (n) => Promise.race([
    new Promise((resolve) => {
      const step = () => (n-- > 0 ? requestAnimationFrame(step) : resolve());
      step();
    }),
    new Promise((resolve) => setTimeout(resolve, 150)),
  ]);

  await document.fonts.ready;
  await new Promise((resolve) => setTimeout(resolve, 700));
  const out = { page: location.pathname, viewport: `${innerWidth}x${innerHeight}`, tabVisible: document.visibilityState === 'visible' };

  for (const theme of ['light', 'dark']) {
    document.documentElement.setAttribute('data-theme', theme);
    await frames(3);
    const loaded = snapshot();

    let shift = 0;
    const shifted = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        shift += entry.value;
        for (const source of entry.sources || []) {
          if (source.node && source.node.nodeType === 1) shifted.push(`${source.node.tagName}.${source.node.className}`);
        }
      }
    });
    observer.observe({ type: 'layout-shift', buffered: false });

    const old = visibleLogo();
    // Built from scratch rather than cloned: a clone (or a changed `src`) keeps
    // showing the image it already has until the new one loads, which would
    // hide exactly the empty state this is here to measure.
    const fresh = document.createElement('img');
    for (const attr of old.attributes) {
      if (attr.name !== 'src') fresh.setAttribute(attr.name, attr.value);
    }
    fresh.src = `${old.getAttribute('src')}?cold=${Date.now()}-${theme}`;
    const arrived = new Promise((resolve) => fresh.addEventListener('load', resolve, { once: true }));
    old.replaceWith(fresh);
    const beforeArrival = snapshot();
    await frames(2);
    await arrived;
    await frames(4);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterArrival = snapshot();
    for (const entry of observer.takeRecords()) shift += entry.value;
    observer.disconnect();

    out[theme] = {
      loaded,
      beforeArrival,
      afterArrival,
      movedOnArrival: Object.keys(afterArrival).filter((key) => afterArrival[key] !== beforeArrival[key]),
      layoutShift: Math.round(shift * 100000) / 100000,
      shiftedNodes: [...new Set(shifted)],
    };
  }
  return out;
})();
