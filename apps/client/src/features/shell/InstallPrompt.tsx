import { Bell, ChevronDown, Download, Share, X } from "lucide-react";
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import { getPushController } from "../../app/backend";
import { type NotificationPermissionState, getPlatform } from "../../platform";
import { useSelectionStore } from "../../state/selection-store";
import { showToast } from "../../state/toast-store";
import { cx } from "../../lib/cx";
import { Button } from "../../ui";
import s from "./AppShell.module.css";
import { useShell } from "./shell-context";

/* The install / notifications onboarding card.
 *
 *  - iPhone or iPad in Safari (not installed): explains Add to Home Screen,
 *    because iOS only delivers web push to an installed app.
 *  - Elsewhere: "Turn on notifications" (the permission prompt is only ever
 *    opened by that button tap), plus "Install app" when the browser offers it.
 *
 * It is rendered IN the layout (a row under the reader on desktop, above the
 * dock on phone), never floating, so it cannot cover a control. It is ONE
 * compact row (title, 44 px dismiss); the explanation and buttons open on tap.
 * On desktop widths it appears only when the app can be installed. It does not
 * show until the user has opened an email, and once dismissed it stays away
 * (remembered in the platform key-value store).
 */

const DISMISSED_KEY = "onboarding.install-prompt.dismissed";
const OPENED_KEY = "onboarding.opened-an-email";

type Variant = "ios" | "notify" | "install";

function subscribeInstall(cb: () => void): () => void {
  return getPlatform().install.subscribe(cb);
}

/** Has the user opened at least one email, in this or an earlier session? */
function useHasOpenedEmail(): boolean {
  const [opened, setOpened] = useState(false);
  const selected = useSelectionStore((x) => x.selectedKey != null);

  useEffect(() => {
    let alive = true;
    void getPlatform()
      .storage.get<boolean>(OPENED_KEY)
      .then((v) => {
        if (alive && v === true) setOpened(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!selected || opened) return;
    setOpened(true);
    void getPlatform().storage.set(OPENED_KEY, true);
  }, [selected, opened]);

  return opened;
}

export function InstallPrompt() {
  const platform = getPlatform();
  // null = not read from storage yet: render nothing rather than flash the card.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermissionState>(() => platform.notifications.permission());
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { phone } = useShell();
  const opened = useHasOpenedEmail();
  const canInstall = useSyncExternalStore(
    subscribeInstall,
    () => getPlatform().install.canPrompt(),
    () => false,
  );

  useEffect(() => {
    let alive = true;
    void getPlatform()
      .storage.get<boolean>(DISMISSED_KEY)
      .then((v) => {
        if (alive) setDismissed(v === true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    void getPlatform().storage.set(DISMISSED_KEY, true);
  }, []);

  // Desktop widths: only when the browser can actually install the app. The
  // notification and Home Screen prompts are for phones.
  const variant: Variant | null = !phone
    ? canInstall
      ? "install"
      : null
    : platform.isIOS && !platform.isStandalone
      ? "ios"
      : platform.notifications.supported && permission === "default"
        ? "notify"
        : canInstall
          ? "install"
          : null;

  if (dismissed !== false || !opened || !variant) return null;

  // Called straight from the button's click handler: browsers (iOS above all)
  // only show the permission prompt in response to a user gesture.
  const enableNotifications = async () => {
    setBusy(true);
    const result = await platform.notifications.requestPermission();
    setPermission(result);
    if (result === "granted") {
      // Permission is granted, so this does not prompt again: it creates the
      // push subscription and registers it with the server (src/app/push.ts).
      const outcome = (await getPushController()?.enable()) ?? "unavailable";
      setBusy(false);
      showToast(
        outcome === "enabled"
          ? "Notifications are on"
          : outcome === "failed"
            ? { text: "Notifications could not be turned on. Try again from the account menu.", kind: "error" }
            : "Notifications are allowed. They will start once they are available for your account.",
      );
      // Stay up only if there is still an install to offer.
      if (!platform.install.canPrompt()) dismiss();
    } else if (result === "denied") {
      setBusy(false);
      showToast("Notifications are blocked. You can allow them in your browser's site settings.");
      dismiss();
    } else setBusy(false);
  };

  const install = async () => {
    const outcome = await platform.install.prompt();
    if (outcome === "accepted") dismiss();
  };

  const title =
    variant === "ios" ? "Get notified about new mail" : variant === "notify" ? "Turn on notifications" : "Install mcpemails";

  // One compact row; the explanation and the buttons open on tap.
  return (
    <aside className={s.notice} aria-label="Notifications and install">
      <div className={s.noticeRow}>
        <button type="button" className={s.noticeToggle} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((v) => !v)}>
          <span className={s.noticeIcon} aria-hidden="true">
            {variant === "install" ? <Download size={15} /> : <Bell size={15} />}
          </span>
          <span className={s.noticeTitle}>{title}</span>
          <ChevronDown size={15} aria-hidden="true" className={cx(s.noticeChevron, expanded && s.noticeChevronOpen)} />
        </button>
        <button type="button" className={s.noticeClose} aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {expanded ? (
        <div id={detailsId} className={s.noticeDetails}>
          {variant === "ios" ? (
            <p className={s.noticeBody}>
              On iPhone and iPad, notifications only work for apps on the Home Screen. Tap{" "}
              <Share size={13} aria-label="Share" className={s.noticeGlyph} /> in Safari, then <strong>Add to Home Screen</strong>, and open
              mcpemails from there.
            </p>
          ) : variant === "notify" ? (
            <p className={s.noticeBody}>Know when new mail arrives, even when mcpemails is not open.</p>
          ) : (
            <p className={s.noticeBody}>Its own window, in your dock or on your home screen.</p>
          )}
          <div className={s.noticeActions}>
            {variant === "notify" ? (
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void enableNotifications()}>
                Turn on notifications
              </Button>
            ) : null}
            {variant !== "ios" && canInstall ? (
              <Button variant={variant === "install" ? "primary" : "secondary"} size="sm" onClick={() => void install()}>
                Install app
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={dismiss}>
              {variant === "ios" ? "Got it" : "Not now"}
            </Button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
