/**
 * One-click install actions per AI client: the single source of truth.
 *
 *   getInstallAction('cursor')
 *   // { client: 'cursor', kind: 'link', href: 'cursor://anysphere.cursor-deeplink/mcp/install?...', label: 'Add to Cursor' }
 *
 * Every link and command is built from MCP_URL (mcp-url.mjs), never from a
 * second copy of the URL. Framework-free and dependency-free: the dashboard
 * guide, the /onboarding flow and the daily drift check
 * (scripts/client-docs-drift.mjs) all import this file as is.
 *
 * kind:
 *   'link'     href opens the client with our server filled in. `alt` is an
 *              optional second link (VS Code Insiders).
 *   'command'  one terminal line to copy.
 *   'steps'    no deep link exists; show the manual steps under `stepsKey`
 *              (a key prefix in messages/<locale>/dashboard.json).
 * `note` is an optional caveat line shown under the button.
 *
 * Link formats, each checked against the vendor's own docs on 2026-10-26 (the
 * drift check re-reads those pages daily and opens an issue when they change):
 *   Claude   https://claude.com/docs/connectors/building/directory-vs-custom.md
 *            claude.ai/customize/connectors?modal=add-custom-connector&connectorName=..&connectorUrl=<encoded>
 *            Works on Free; a signed-out user signs in first.
 *   Cursor   https://cursor.com/docs/mcp/install-links
 *            cursor://anysphere.cursor-deeplink/mcp/install?name=..&config=<base64 of the server JSON>
 *            The config is the server object only ({"url": ...}), not wrapped in mcpServers.
 *   VS Code  https://code.visualstudio.com/api/extension-guides/ai/mcp
 *            vscode:mcp/install?<encodeURIComponent(JSON.stringify({name, type, url}))>
 *            vscode-insiders: for Insiders.
 *   Goose    https://goose-docs.ai/docs/getting-started/using-extensions
 *            goose://extension?url=..&type=streamable_http&id=..&name=..&description=..&timeout=..
 *   ChatGPT  no prefill link exists for a custom MCP server (help.openai.com 12584461).
 *
 * Slugs: the onboarding / funnel ids (`claude_code`, `curl`) and the /docs
 * slugs (`claude-code`, `gemini-cli`) are both accepted. `gemini` means Gemini
 * CLI here, as in the dashboard guide and the onboarding chip; the Gemini app
 * has no install action.
 */
import { MCP_URL } from './mcp-url.mjs';

/** Display name the client shows. */
export const INSTALL_DISPLAY_NAME = 'MCPEmails';
/** Server id written into client configs: lowercase, as in every snippet we publish. */
export const INSTALL_SERVER_ID = INSTALL_DISPLAY_NAME.toLowerCase();

const LOCALES = ['en', 'de', 'fr', 'es', 'nb', 'zh'];

/**
 * Button labels and notes. Product names stay untranslated. Kept here rather
 * than in messages/: the dashboard and /onboarding load different namespaces,
 * and this file has to work in both without either shipping the other's copy.
 */
const COPY = {
  en: {
    addTo: (name) => `Add to ${name}`,
    installIn: (name) => `Install in ${name}`,
    command: 'Run this in your terminal',
    steps: 'Follow these steps',
    claudeFreeNote: 'Claude Free allows one custom connector. If you already have one, remove it first.',
  },
  de: {
    addTo: (name) => `Zu ${name} hinzufügen`,
    installIn: (name) => `In ${name} installieren`,
    command: 'Im Terminal ausführen',
    steps: 'Folgen Sie diesen Schritten',
    claudeFreeNote: 'Claude Free erlaubt einen benutzerdefinierten Konnektor. Wenn Sie schon einen haben, entfernen Sie ihn zuerst.',
  },
  fr: {
    addTo: (name) => `Ajouter à ${name}`,
    installIn: (name) => `Installer dans ${name}`,
    command: 'À exécuter dans votre terminal',
    steps: 'Suivez ces étapes',
    claudeFreeNote: "Claude Free n'autorise qu'un seul connecteur personnalisé. Si vous en avez déjà un, supprimez-le d'abord.",
  },
  es: {
    addTo: (name) => `Añadir a ${name}`,
    installIn: (name) => `Instalar en ${name}`,
    command: 'Ejecútalo en tu terminal',
    steps: 'Sigue estos pasos',
    claudeFreeNote: 'Claude Free permite un solo conector personalizado. Si ya tienes uno, elimínalo primero.',
  },
  nb: {
    addTo: (name) => `Legg til i ${name}`,
    installIn: (name) => `Installer i ${name}`,
    command: 'Kjør dette i terminalen',
    steps: 'Følg disse stegene',
    claudeFreeNote: 'Claude Free tillater én egendefinert connector. Har du allerede en, fjerner du den først.',
  },
  zh: {
    addTo: (name) => `添加到 ${name}`,
    installIn: (name) => `在 ${name} 中安装`,
    command: '在终端中运行',
    steps: '按以下步骤操作',
    claudeFreeNote: 'Claude 免费版只能添加一个自定义连接器。如果你已经有一个，请先将其移除。',
  },
};

function copyFor(locale) {
  const base = typeof locale === 'string' ? locale.toLowerCase().split(/[-_]/)[0] : 'en';
  return COPY[LOCALES.includes(base) ? base : 'en'];
}

/** UTF-8 safe base64 with the platform btoa (browsers and Node 16+). */
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0)));

/** claude.ai prefill link for the Add custom connector dialog. */
export function claudeInstallHref(url = MCP_URL) {
  const q = new URLSearchParams({ modal: 'add-custom-connector', connectorName: INSTALL_DISPLAY_NAME, connectorUrl: url });
  return `https://claude.ai/customize/connectors?${q.toString()}`;
}

/**
 * Cursor deep link. The config is base64 of `{"url": ...}` and goes in raw, as
 * Cursor's docs show: a forum thread reports the generator breaking on
 * double-encoded configs. The production URL's base64 has no `+`, `/` or `=`.
 */
export function cursorInstallHref(url = MCP_URL) {
  const config = b64(JSON.stringify({ url }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${INSTALL_SERVER_ID}&config=${config}`;
}

/** VS Code (or Insiders) install link. */
export function vscodeInstallHref(url = MCP_URL, { insiders = false } = {}) {
  const json = JSON.stringify({ name: INSTALL_SERVER_ID, type: 'http', url });
  return `${insiders ? 'vscode-insiders' : 'vscode'}:mcp/install?${encodeURIComponent(json)}`;
}

/**
 * https forms of the Cursor and VS Code links, for places that drop custom
 * schemes: GitHub strips cursor: and vscode: hrefs from a README. Each page
 * redirects to the app link above (checked 2026-10-29: Cursor's install-mcp
 * page, and vscode.dev's redirect answering 302 to vscode:mcp/install).
 * Not in Cursor's or VS Code's docs, so the README test pins them to
 * this file and a change shows up in one place.
 */
export function cursorWebInstallHref(url = MCP_URL) {
  return `https://cursor.com/install-mcp?name=${INSTALL_SERVER_ID}&config=${b64(JSON.stringify({ url }))}`;
}

export function vscodeWebInstallHref(url = MCP_URL) {
  const q = new URLSearchParams({ name: INSTALL_SERVER_ID, config: JSON.stringify({ type: 'http', url }) });
  return `https://insiders.vscode.dev/redirect/mcp/install?${q.toString()}`;
}

/** Goose extension deep link for a remote Streamable HTTP server. */
export function gooseInstallHref(url = MCP_URL) {
  const q = new URLSearchParams({
    url,
    type: 'streamable_http',
    id: INSTALL_SERVER_ID,
    name: INSTALL_DISPLAY_NAME,
    description: 'Read, search, draft and send email',
    timeout: '300',
  });
  return `goose://extension?${q.toString()}`;
}

/** Terminal one-liners, keyed by canonical slug. */
export const INSTALL_COMMANDS = Object.freeze({
  'claude-code': (url) => `claude mcp add --transport http ${INSTALL_SERVER_ID} ${url}`,
  codex: (url) => `codex mcp add ${INSTALL_SERVER_ID} --url ${url}`,
  'gemini-cli': (url) => `gemini mcp add --transport http ${INSTALL_SERVER_ID} ${url}`,
});

const ALIASES = Object.freeze({
  claude_code: 'claude-code',
  gemini: 'gemini-cli',
  gemini_cli: 'gemini-cli',
  cowork: 'claude',
  code: 'vscode',
  'vs-code': 'vscode',
});

/** Canonical slug for any id the dashboard, onboarding or /docs uses. */
export function installSlug(clientSlug) {
  if (typeof clientSlug !== 'string') return null;
  const s = clientSlug.trim().toLowerCase();
  return ALIASES[s] ?? s;
}

/** Every slug that has an install action, canonical form. */
export const INSTALLABLE_CLIENTS = Object.freeze(['claude', 'cursor', 'vscode', 'goose', 'claude-code', 'codex', 'gemini-cli', 'chatgpt']);

/**
 * The install action for a client, or null when it has none (then show the
 * manual steps only).
 *
 * @param {string} clientSlug  e.g. 'claude', 'cursor', 'claude_code', 'gemini-cli'
 * @param {{ locale?: string, mcpUrl?: string }} [opts]
 * @returns {null | { client: string, kind: 'link'|'command'|'steps', href?: string, command?: string,
 *   stepsKey?: string, label: string, note?: string, alt?: { href: string, label: string } }}
 */
export function getInstallAction(clientSlug, { locale = 'en', mcpUrl = MCP_URL } = {}) {
  const slug = installSlug(clientSlug);
  const c = copyFor(locale);
  switch (slug) {
    case 'claude':
      return { client: 'claude', kind: 'link', href: claudeInstallHref(mcpUrl), label: c.addTo('Claude'), note: c.claudeFreeNote };
    case 'cursor':
      return { client: 'cursor', kind: 'link', href: cursorInstallHref(mcpUrl), label: c.addTo('Cursor') };
    case 'vscode':
      return {
        client: 'vscode',
        kind: 'link',
        href: vscodeInstallHref(mcpUrl),
        label: c.installIn('VS Code'),
        alt: { href: vscodeInstallHref(mcpUrl, { insiders: true }), label: c.installIn('VS Code Insiders') },
      };
    case 'goose':
      return { client: 'goose', kind: 'link', href: gooseInstallHref(mcpUrl), label: c.addTo('Goose') };
    case 'claude-code':
    case 'codex':
    case 'gemini-cli':
      return { client: slug, kind: 'command', command: INSTALL_COMMANDS[slug](mcpUrl), label: c.command };
    case 'chatgpt':
      return { client: 'chatgpt', kind: 'steps', stepsKey: 'clients.chatgpt', label: c.steps };
    default:
      return null;
  }
}

/**
 * The install action a public /docs/<slug> page shows in its hero, or null.
 * Only links and commands: ChatGPT's steps are already the page itself. The
 * docs slug `gemini` is the Gemini app, which has no install action, so it
 * must not fall through to the Gemini CLI alias.
 */
export function docsPageInstallAction(docsSlug, opts) {
  if (docsSlug === 'gemini') return null;
  const action = getInstallAction(docsSlug, opts);
  return action && (action.kind === 'link' || action.kind === 'command') ? action : null;
}

/**
 * The MCP URL a link or command installs, read back out of it. The tests and
 * the drift check use this to prove every action still points at the live
 * endpoint. Returns null for anything it cannot decode.
 */
export function decodeInstallTarget(action) {
  if (!action) return null;
  try {
    if (action.kind === 'command') {
      const m = action.command.match(/https?:\/\/\S+/);
      return m ? m[0] : null;
    }
    if (action.kind !== 'link') return null;
    const href = action.href;
    if (href.startsWith('https://claude.ai/')) return new URL(href).searchParams.get('connectorUrl');
    if (href.startsWith('cursor://')) {
      const config = href.match(/[?&]config=([^&]+)/)?.[1];
      return config ? JSON.parse(unb64(config)).url ?? null : null;
    }
    if (/^vscode(-insiders)?:mcp\/install\?/.test(href)) {
      return JSON.parse(decodeURIComponent(href.slice(href.indexOf('?') + 1))).url ?? null;
    }
    if (href.startsWith('goose://')) return new URL(href).searchParams.get('url');
  } catch {
    return null;
  }
  return null;
}
