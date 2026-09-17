// A jsdom document and a React root, for suites that render real components.
//
// `jsdom`, `react` and `react-dom` are all direct dependencies of this package,
// so nothing here adds to the install. React reads `window` and `document` at
// module-evaluation time, which is why `installDom()` has to run BEFORE the
// first `import` of anything that pulls React in: callers use a dynamic
// `await import()` after calling it, not a top-level static import.
import { JSDOM } from 'jsdom';

/**
 * Installs the globals a React DOM render needs onto `globalThis`.
 * Idempotent, and safe to call once per test file.
 */
export function installDom() {
  if (globalThis.document) return globalThis.window;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://mcpemails.com/dashboard',
    pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // Node 22 exposes its own `navigator` as a getter-only accessor, so a plain
  // assignment throws. jsdom's is the one React and the components read.
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  globalThis.window.matchMedia = globalThis.matchMedia;
  // React 19 checks this to decide whether `act` is legal.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom.window;
}

/**
 * Mounts `element` into a detached container and returns it with an
 * `act`-wrapped updater and an unmount. Every caller must `unmount()`, or a
 * pending state update from one test lands in the next one's container.
 */
export async function mount(element) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async update(next) { await act(async () => { root.render(next); }); },
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

/** Runs `fn` inside `act`, flushing the effects and microtasks it queues. */
export async function flush(fn = () => {}) {
  const { act } = await import('react');
  await act(async () => { await fn(); });
}

/** Clicks a checkbox the way a person does, through React's synthetic event. */
export async function toggle(input) {
  await flush(async () => {
    input.checked = !input.checked;
    input.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
}
