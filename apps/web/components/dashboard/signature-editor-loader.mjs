// ---------------------------------------------------------------------------
// Loads the signature editor (TipTap + ProseMirror) and the signature
// sanitiser (DOMPurify) on demand.
//
// Together they are the largest single piece of the dashboard's JavaScript,
// about 460 KB, and they are used in one place: the "Signature & sending"
// panel of the inbox detail modal. Statically imported from Pages.jsx, they
// were downloaded and parsed on every dashboard page load.
//
// BOTH come through this one loader, as a pair, on purpose. The sanitiser is
// the same module the editor itself imports (`@/lib/sanitizeSignatureHtml`),
// not a copy: the preview, the save path and the editor all run the one
// allow-list. Loading them together also means the form never has an editor
// without the sanitiser its preview needs, or the reverse.
//
// The result is kept, so the second time the modal opens the editor is there
// on the first render exactly as when it was bundled. A failed load is NOT
// kept: the next call tries again.
// ---------------------------------------------------------------------------

let loaded = null;
let loading = null;

/** The editor module pair if it has already loaded, else null. Never loads. */
export function peekSignatureEditor() {
  return loaded;
}

/**
 * Resolves with `{ SignatureRichEditor, sanitizeSignatureHtml }`. Concurrent
 * calls share one fetch. Safe to call early (on hover or focus) to warm it.
 */
export function loadSignatureEditor() {
  if (loaded) return Promise.resolve(loaded);
  if (!loading) {
    loading = Promise.all([
      import('./SignatureRichEditor'),
      import('@/lib/sanitizeSignatureHtml'),
    ]).then(
      ([editor, sanitizer]) => {
        loaded = {
          SignatureRichEditor: editor.default,
          sanitizeSignatureHtml: sanitizer.sanitizeSignatureHtml,
        };
        loading = null;
        return loaded;
      },
      (err) => {
        loading = null;
        throw err;
      },
    );
  }
  return loading;
}

/** Starts the load and ignores the outcome. For hover / focus warm-up. */
export function warmSignatureEditor() {
  loadSignatureEditor().catch(() => {});
}
