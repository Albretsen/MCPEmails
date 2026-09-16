// ---------------------------------------------------------------------------
// Hand-rolled MCP Apps (io.modelcontextprotocol/ui) client.
//
// Why not `@modelcontextprotocol/ext-apps`'s `App` class: phase-0 measured it at
// 346 KB bundled (~340 KB of which is the MCP SDK + zod) and found that the host
// re-fetches the UI resource on EVERY tool call with no caching anywhere
// (findings Q3/Q4). That is 346 KB out of a Supabase edge function per call.
// The SEP documents this dependency-free postMessage JSON-RPC pattern
// explicitly; this file is it, in ~200 lines.
//
// Wire shapes are taken verbatim from ext-apps v1.7.5 `src/spec.types.ts` and
// from the traffic captured in phase-0.
// ---------------------------------------------------------------------------

export const UI_PROTOCOL_VERSION = "2026-01-26";

export type DisplayMode = "inline" | "fullscreen" | "pip";
export type Theme = "light" | "dark";

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * `hostContext.toolInfo`: the `tools/call` that instantiated this app.
 *
 * `id` is the JSON-RPC request id of that call and `tool` is the full tool
 * definition, so `tool.name` says which of our tools produced the card. Purely
 * diagnostic here, and optional: phase-0 Q6 recorded `toolInfo` as one of the
 * fields the ext-apps reference host does not send at all, so nothing may
 * depend on it being present.
 */
export interface ToolInfo {
  id?: string | number;
  tool?: { name?: string; title?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface HostContext {
  theme?: Theme;
  displayMode?: DisplayMode;
  availableDisplayModes?: DisplayMode[];
  toolInfo?: ToolInfo;
  containerDimensions?: {
    width?: number;
    maxWidth?: number;
    height?: number;
    maxHeight?: number;
  };
  platform?: string;
  locale?: string;
  timeZone?: string;
  safeAreaInsets?: SafeAreaInsets;
  styles?: { variables?: Record<string, string> };
  [key: string]: unknown;
}

export interface HostCapabilities {
  openLinks?: object;
  serverTools?: object;
  serverResources?: object;
  updateModelContext?: object;
  message?: object;
  downloadFile?: object;
  [key: string]: unknown;
}

export interface ToolResultParams {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Params of `ui/notifications/tool-cancelled`. The spec says the host MUST send
 * this "if the tool execution was cancelled, for any reason (which can
 * optionally be specified), including user action, sampling error, classifier
 * intervention", so `reason` is best-effort prose and may be absent.
 */
export interface ToolCancelledParams {
  reason?: string;
  [key: string]: unknown;
}

export type LogLevel = "debug" | "info" | "warning" | "error";

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

type Json = Record<string, unknown>;

const INITIALIZE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * How long `ui/resource-teardown` waits for an async teardown handler before
 * replying anyway.
 *
 * The spec says the host "SHOULD wait for a response before tearing down the
 * resource (to prevent data loss)", which is what lets the draft editor save a
 * dirty draft on close. That same sentence is why this cap exists: a host that
 * waits on us is a host we can hang. A save is one `tools/call` round trip
 * through the host to the edge function, so seconds, not minutes; 8s is past
 * any plausible save and short enough that a stuck one does not read as a
 * frozen client. Whichever finishes first, the reply is sent exactly once.
 */
export const TEARDOWN_TIMEOUT_MS = 8_000;

export class HostBridge {
  hostContext: HostContext = {};
  hostCapabilities: HostCapabilities = {};
  hostInfo: { name?: string; version?: string } = {};
  /**
   * The protocol version the host echoed from `ui/initialize`, which is not
   * necessarily the one we asked for. Recorded rather than discarded because it
   * is the first thing worth knowing when a card misbehaves against one host
   * and not another: the whole point of the handshake is that the host picks.
   */
  protocolVersion: string | null = null;
  connected = false;

  /**
   * Handshake instrumentation. INTERNAL v1 ONLY, same lifetime as the
   * diagnostics line in App.tsx.
   *
   * `initializeAttempts` is how many `ui/initialize` requests were posted
   * before one was answered. `rxAccepted` counts JSON-RPC messages that passed
   * the source check; `rxForeign` counts JSON-RPC-shaped messages that were
   * dropped because they came from a window other than our parent.
   *
   * Together they separate the two ways a handshake can die silently, which is
   * otherwise unknowable from inside a sandboxed frame: `rxAccepted 0` with
   * `rxForeign 0` means the host never spoke to us at all and retrying is the
   * right fix; a non-zero `rxForeign` would mean the host IS speaking and our
   * source check is throwing its messages away, which is a different bug with a
   * different fix.
   */
  initializeAttempts = 0;
  rxAccepted = 0;
  rxForeign = 0;

  onToolInput?: (args: Record<string, unknown> | undefined) => void;
  onToolResult?: (params: ToolResultParams) => void;
  onToolCancelled?: (params: ToolCancelledParams) => void;
  onHostContextChanged?: (patch: HostContext) => void;
  /**
   * May be async. `ui/resource-teardown` is a REQUEST, and the reply is held
   * until this resolves (or `TEARDOWN_TIMEOUT_MS` elapses), which is what lets
   * a dirty draft editor save before the frame goes away. A sync handler, as
   * every other card has, replies in the same tick as before.
   */
  onTeardown?: () => void | Promise<void>;
  /**
   * Fired before each `ui/initialize` attempt. INTERNAL v1 ONLY: it exists so
   * the diagnostics line can re-render while the handshake is still being
   * retried. Without it the counters freeze at their first-paint values, which
   * on the one card that matters — the one that never connects — is precisely
   * the wrong number.
   */
  onInitializeAttempt?: () => void;

  private nextId = 1;
  private pending = new Map<number, Pending>();
  private target: Window = window.parent;
  private listening = false;

  // -- transport ------------------------------------------------------------

  private listen() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as Json | undefined;
      const isRpc = !!data && (data as Json).jsonrpc === "2.0";
      // Validate the source window. The card's parent is the sandbox proxy
      // frame; anything else is not the host. This check is byte-identical to
      // the reference `PostMessageTransport`'s, so it is not a place our
      // hand-rolled bridge diverges — but a dropped message here is invisible,
      // so a JSON-RPC-shaped message from elsewhere is counted before it goes.
      if (event.source !== this.target) {
        if (isRpc) this.rxForeign++;
        return;
      }
      if (!isRpc) return;
      this.rxAccepted++;
      this.handle(data as Json);
    });
  }

  private post(message: Json) {
    // "*" matches the reference PostMessageTransport: the sandbox proxy is on a
    // different, host-chosen origin that the card cannot know. The sandbox
    // relays to the host with a pinned origin.
    this.target.postMessage(message, "*");
  }

  private handle(msg: Json) {
    const id = msg.id as number | undefined;

    // Response to one of our requests.
    if (id !== undefined && (("result" in msg) || ("error" in msg))) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if ("error" in msg) {
        const e = (msg.error ?? {}) as Json;
        p.reject(new Error(`${e.code ?? "?"}: ${e.message ?? "unknown error"}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    const method = msg.method as string | undefined;
    if (!method) return;
    const params = (msg.params ?? {}) as Json;

    // Host -> app notifications.
    if (id === undefined) {
      switch (method) {
        case "ui/notifications/tool-input":
          this.onToolInput?.(params.arguments as Record<string, unknown>);
          return;
        case "ui/notifications/tool-result":
          this.onToolResult?.(params as ToolResultParams);
          return;
        case "ui/notifications/tool-cancelled":
          // The host MUST send this when a call is cancelled for any reason
          // (user action, sampling error, classifier intervention). Ignoring it
          // used to strand the card on its loading skeleton forever, because
          // tool-result is the only other thing that can end the wait and a
          // cancelled call never produces one.
          this.onToolCancelled?.(params as ToolCancelledParams);
          return;
        case "ui/notifications/host-context-changed":
          this.mergeContext(params as HostContext);
          this.onHostContextChanged?.(params as HostContext);
          return;
        case "ui/notifications/request-teardown":
          // A notification: nothing to reply to, so nothing to wait for.
          void this.runTeardown();
          return;
        default:
          return; // tool-input-partial, ... : nothing to do.
      }
    }

    // Host -> app requests. Anything we do not answer with a well-formed
    // response looks, from the host's side, like a dead frame.
    if (method === "ui/resource-teardown") {
      // The reply is what the host waits on, so it is sent AFTER the handler
      // has had its chance to save. Exactly once: a handler that resolves
      // after the timeout already fired must not post a second response.
      let replied = false;
      const reply = () => {
        if (replied) return;
        replied = true;
        this.post({ jsonrpc: "2.0", id, result: {} });
      };
      void this.runTeardown().then(reply, reply);
      return;
    }
    if (method === "ping") {
      // Liveness check. Claude's own MCP Apps docs call out that a hand-rolled
      // postMessage bridge "will silently drop requests sent from the host to
      // the widget, such as ping (a liveness check)". Answering -32601 is not
      // silence, but it is not much better: a host is entitled to read "method
      // not found" on its own liveness probe as "this frame is not a
      // conforming app" and tear the card down. An empty result is the whole
      // contract. Claude.ai web is not believed to send ping today, which is
      // exactly why this must not be left to be discovered in production.
      this.post({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    this.post({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  /**
   * Run the teardown handler, never throw, never take longer than
   * `TEARDOWN_TIMEOUT_MS`. A sync handler resolves without a timer at all, so
   * the cards that do not save on teardown keep their old timing exactly.
   */
  private async runTeardown(): Promise<void> {
    const handler = this.onTeardown;
    if (!handler) return;
    try {
      const result = handler();
      if (!result || typeof (result as Promise<void>).then !== "function") return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (result as Promise<void>).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TEARDOWN_TIMEOUT_MS);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    } catch {
      /* a failed save must never cost the host its reply */
    }
  }

  private request<T = unknown>(
    method: string,
    params: Json,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    this.listen();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.post({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Json) {
    this.listen();
    this.post({ jsonrpc: "2.0", method, params });
  }

  private mergeContext(patch: HostContext) {
    // host-context-changed carries only the changed fields.
    this.hostContext = { ...this.hostContext, ...patch };
  }

  // -- handshake ------------------------------------------------------------

  async connect(appInfo: { name: string; version: string }): Promise<void> {
    this.listen();

    const params: Json = {
      appInfo,
      appCapabilities: {
        availableDisplayModes: ["inline", "fullscreen"],
      },
      protocolVersion: UI_PROTOCOL_VERSION,
    };

    // ── Why this retries, when the reference SDK does not ──────────────────
    // `App.connect()` in @modelcontextprotocol/ext-apps posts `ui/initialize`
    // exactly once and waits. That is fine when the host is already listening,
    // and it is how this bridge behaved until 2026-09-16, when the first
    // diagnostics line from a RE-MOUNTED card in Claude came back reading
    // `host ? ? · mode ? · result none · input no`: no initialize result, no
    // host info, no tool-input, nothing. The card was not waiting for a tool
    // result, it had never completed the handshake at all, and so it sat on its
    // loading line until the 10s timeout.
    //
    // A first mount works, a re-mount does not, and the difference is when the
    // host starts listening. Our `ui/initialize` goes out during initial module
    // evaluation, which for a lazily re-mounted conversation cell can be before
    // the host has wired its side of the channel. A `postMessage` with no
    // listener is not queued and not returned; it is simply gone. One shot
    // means one chance, and losing it costs the entire card.
    //
    // So the request is re-posted until the host answers or the overall budget
    // runs out. Each attempt carries a fresh JSON-RPC id, which keeps every
    // attempt independently answerable; `handle()` ignores responses whose id
    // is no longer pending, so a host that answers two of them is harmless. The
    // total budget is unchanged at INITIALIZE_TIMEOUT_MS, so a host that is
    // genuinely absent fails in exactly the same time it did before.
    const deadline = Date.now() + INITIALIZE_TIMEOUT_MS;
    let attemptMs = 250;
    let lastError: unknown;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw lastError instanceof Error
          ? lastError
          : new Error("ui/initialize timed out");
      }
      this.initializeAttempts++;
      this.onInitializeAttempt?.();
      try {
        const answered = await this.request<{
          protocolVersion?: string;
          hostInfo?: Json;
          hostCapabilities?: HostCapabilities;
          hostContext?: HostContext;
        }>("ui/initialize", params, Math.min(attemptMs, remaining));
        return this.applyInitializeResult(answered);
      } catch (e) {
        // Only a timeout is worth another attempt. An actual JSON-RPC error
        // response means the host heard us and refused, and re-asking a host
        // that has already answered is noise, not resilience.
        lastError = e;
        if (!(e instanceof Error) || !/timed out$/.test(e.message)) throw e;
        // Back off, but stay frequent enough that a host which starts
        // listening a second in is not kept waiting for the next attempt.
        attemptMs = Math.min(attemptMs * 2, 2_000);
      }
    }
  }

  /** Record what the host told us at `ui/initialize` and finish the handshake. */
  private applyInitializeResult(
    result: {
      protocolVersion?: string;
      hostInfo?: Json;
      hostCapabilities?: HostCapabilities;
      hostContext?: HostContext;
    } | undefined,
  ): void {

    // `McpUiInitializeResult` carries protocolVersion, hostInfo,
    // hostCapabilities and hostContext, and deliberately carries NO tool
    // result. Nothing here can hydrate the card; the only thing the handshake
    // settles about the result is that it has not arrived yet.
    this.protocolVersion =
      typeof result?.protocolVersion === "string" ? result.protocolVersion : null;
    this.hostInfo = (result?.hostInfo ?? {}) as { name?: string; version?: string };
    this.hostCapabilities = result?.hostCapabilities ?? {};
    this.hostContext = result?.hostContext ?? {};
    this.connected = true;
    this.notify("ui/notifications/initialized", {});
  }

  // -- app -> host ----------------------------------------------------------

  callServerTool(name: string, args: Json): Promise<ToolResultParams> {
    return this.request<ToolResultParams>("tools/call", {
      name,
      arguments: args,
    });
  }

  async requestDisplayMode(mode: DisplayMode): Promise<DisplayMode> {
    const r = await this.request<{ mode?: DisplayMode }>(
      "ui/request-display-mode",
      { mode },
    );
    const actual = r?.mode ?? mode;
    this.hostContext.displayMode = actual;
    return actual;
  }

  async openLink(url: string): Promise<boolean> {
    if (!/^https:\/\//i.test(url)) throw new Error("refusing non-https link");
    const r = await this.request<{ isError?: boolean }>("ui/open-link", { url });
    return !r?.isError;
  }

  updateModelContext(text: string, structured?: Json): Promise<unknown> {
    if (!this.hostCapabilities.updateModelContext) return Promise.resolve(null);
    return this.request("ui/update-model-context", {
      content: [{ type: "text", text }],
      ...(structured ? { structuredContent: structured } : {}),
    }).catch(() => null);
  }

  sendSizeChanged(width: number, height: number) {
    this.notify("ui/notifications/size-changed", { width, height });
  }

  /**
   * Fire-and-forget line to the host's log channel.
   *
   * The spec's interactive-phase diagram shows the host recording
   * `notifications/message` for debugging and telemetry. It is a notification,
   * so there is no reply to wait for and no failure to handle: whether the host
   * keeps the line, drops it, or has no log channel at all, the card must
   * render exactly the same. Hence the swallow. This must never be able to
   * throw into a render path, because the one moment it gets used is the moment
   * something has already gone wrong.
   *
   * Nothing from a tool payload goes in here. The call sites log protocol
   * facts (versions, host name, tool name, elapsed ms), not email content.
   */
  log(level: LogLevel, data: Json) {
    try {
      this.notify("notifications/message", {
        level,
        logger: "mcpemails.review-card",
        data,
      });
    } catch {
      /* the log channel is never worth an exception */
    }
  }

  /**
   * Auto-fit: inline cards must never scroll internally, so the host has to be
   * told the real content height. Same measurement trick the reference
   * implementation uses — `max-content` on <html> so a card taller than the
   * current iframe reports its full height instead of the clamped one.
   */
  observeSize(): () => void {
    let scheduled = false;
    let lastW = 0;
    let lastH = 0;

    const measure = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const html = document.documentElement;
        const prev = html.style.height;
        html.style.height = "max-content";
        const height = Math.ceil(html.getBoundingClientRect().height);
        html.style.height = prev;
        const width = Math.ceil(window.innerWidth);
        if (width !== lastW || height !== lastH) {
          lastW = width;
          lastH = height;
          this.sendSizeChanged(width, height);
        }
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    ro.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }
}
