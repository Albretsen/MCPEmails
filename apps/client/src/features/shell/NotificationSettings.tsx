import { Share, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { describeError } from "../../api/http/client";
import type { Inbox } from "../../api/types";
import { getPushController } from "../../app/backend";
import type { InboxPushPreference, PayloadMode, PushController, PushPreferences, PushState } from "../../app/push";
import { useSessionStore } from "../../auth";
import { showToast } from "../../state/toast-store";
import { useUiStore } from "../../state/ui-store";
import { Button, IconButton, Spinner } from "../../ui";
import s from "./AppShell.module.css";
import { trapTab, useModalFocus } from "./focus-trap";

/* Notifications (account menu). Two different things live here and are kept
 * apart on purpose:
 *
 *   THIS DEVICE   whether this browser receives notifications at all. The
 *                 permission prompt is opened only by the "Turn on" button.
 *   THE ACCOUNT   per mailbox on / off, what a notification may show, and
 *                 quiet hours. These follow the person to every device.
 *
 * Mounted only while open. `controller` is a prop so tests can hand in a fake.
 */

const DEFAULT_QUIET = { start: "22:00", end: "07:00" };

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function inboxLabel(inboxes: readonly Inbox[], id: string): string {
  const inbox = inboxes.find((i) => i.inbox_id === id);
  return inbox?.display_name || inbox?.email_address || "Mailbox";
}

function DeviceNote({ state }: { state: PushState }) {
  switch (state.availability) {
    case "needs_install":
      return (
        <p className={s.dialogNote}>
          On iPhone and iPad, notifications only work for apps on the Home Screen. Tap{" "}
          <Share size={13} aria-label="Share" className={s.noticeGlyph} /> in Safari, then <strong>Add to Home Screen</strong>, open mcpemails
          from there and come back to this screen.
        </p>
      );
    case "unsupported":
      return <p className={s.dialogNote}>This browser does not support notifications.</p>;
    case "blocked":
      return (
        <p className={s.dialogNote}>
          Notifications are blocked for this site. Allow them in your browser&apos;s site settings, then turn them on here.
        </p>
      );
    case "unavailable":
      return <p className={s.dialogNote}>Notifications are not available in this version of the app yet.</p>;
    default:
      return (
        <p className={s.dialogNote}>
          {state.subscribed
            ? "This device is told when new mail arrives, also while the app is closed."
            : "Get told when new mail arrives, also while the app is closed."}
        </p>
      );
  }
}

export function NotificationSettings({ controller = getPushController() }: { controller?: PushController | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const modeName = useId();
  const sessionInboxes = useSessionStore((x) => x.session?.inboxes);
  const [state, setState] = useState<PushState | null>(null);
  const [prefs, setPrefs] = useState<PushPreferences | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useModalFocus(ref, closeRef);

  const close = () => useUiStore.getState().setMenu(null);

  const refresh = useCallback(async () => {
    if (!controller) return;
    setState(await controller.state());
    try {
      setPrefs(await controller.preferences());
      setLoadError(null);
    } catch (e) {
      setLoadError(describeError(e, "Your notification settings could not be loaded."));
    }
  }, [controller]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Straight from the click: browsers only show the permission prompt in
  // response to a user gesture.
  const turnOn = async () => {
    if (!controller) return;
    setBusy(true);
    const result = await controller.enable();
    setBusy(false);
    if (result === "enabled") showToast("Notifications are on");
    else if (result === "blocked") showToast("Notifications are blocked. You can allow them in your browser's site settings.");
    else if (result === "failed") showToast({ text: "Notifications could not be turned on. Try again.", kind: "error" });
    else if (result === "unavailable") showToast("Notifications are not available here yet.");
    await refresh();
  };

  const turnOff = async () => {
    if (!controller) return;
    setBusy(true);
    await controller.disable();
    setBusy(false);
    showToast("Notifications are off on this device");
    await refresh();
  };

  /** Optimistic: the switch moves at once and moves back if the save fails. */
  const save = async (changes: Array<Partial<InboxPushPreference> & { inbox_id: string }>) => {
    if (!controller || !prefs) return;
    const before = prefs;
    const byId = new Map(changes.map((c) => [c.inbox_id, c]));
    setPrefs({ ...prefs, inboxes: prefs.inboxes.map((p) => ({ ...p, ...(byId.get(p.inbox_id) ?? {}) })) });
    try {
      const saved = await controller.savePreferences(changes);
      setPrefs((current) => (current ? { ...current, inboxes: saved } : current));
    } catch (e) {
      setPrefs(before);
      showToast({ text: describeError(e, "That setting could not be saved."), kind: "error" });
    }
  };

  const sendTest = async () => {
    if (!controller) return;
    setBusy(true);
    try {
      const result = await controller.sendTest();
      if (result.sent > 0) showToast("Test notification sent");
      else if (result.devices === 0) showToast("No device has notifications turned on yet.");
      else showToast({ text: "The test could not be delivered. Turn notifications off and on again on this device.", kind: "error" });
    } catch (e) {
      showToast({ text: describeError(e, "The test notification could not be sent."), kind: "error" });
    }
    setBusy(false);
  };

  const inboxes = prefs?.inboxes ?? [];
  const mode: PayloadMode = inboxes.length > 0 && inboxes.every((p) => p.payload_mode === "private") ? "private" : "rich";
  const quiet = inboxes.find((p) => p.quiet_hours)?.quiet_hours ?? null;
  const setAll = (patch: Partial<InboxPushPreference>) => void save(inboxes.map((p) => ({ inbox_id: p.inbox_id, ...patch })));
  const setQuiet = (next: { start: string; end: string } | null) =>
    setAll({ quiet_hours: next ? { ...next, timezone: quiet?.timezone ?? localTimezone() } : null });

  return (
    <>
      <div className={s.scrim} onPointerDown={close} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={s.dialog} onKeyDown={trapTab}>
        <header className={s.dialogHead}>
          <h2 id={titleId} className={s.dialogTitle}>
            Notifications
          </h2>
          <IconButton ref={closeRef} label="Close" hint="Esc" size="sm" onClick={close}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </header>

        <div className={s.settingsBody} data-scroller="">
          {!controller ? (
            <p className={s.dialogNote}>Notifications are not available in the demo.</p>
          ) : !state ? (
            <Spinner />
          ) : (
            <>
              <section className={s.settingsGroup} aria-label="This device">
                <h3 className={s.helpGroupTitle}>This device</h3>
                <div className={s.settingsRow}>
                  <span>{state.subscribed ? "Notifications are on" : "Notifications are off"}</span>
                  {state.subscribed ? (
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void turnOff()}>
                      Turn off
                    </Button>
                  ) : (
                    <Button variant="primary" size="sm" disabled={busy || state.availability !== "ready"} onClick={() => void turnOn()}>
                      Turn on notifications
                    </Button>
                  )}
                </div>
                <DeviceNote state={state} />
                {prefs && !prefs.configured ? <p className={s.dialogNote}>The server is not set up to send notifications yet.</p> : null}
              </section>

              {loadError ? (
                <p className={s.dialogNote} role="alert">
                  {loadError}
                </p>
              ) : null}

              {prefs && inboxes.length > 0 ? (
                <>
                  <section className={s.settingsGroup} aria-label="Mailboxes">
                    <h3 className={s.helpGroupTitle}>Mailboxes</h3>
                    {inboxes.map((p) => (
                      <label key={p.inbox_id} className={s.settingsRow}>
                        <span className={s.settingsLabel}>{inboxLabel(sessionInboxes ?? [], p.inbox_id)}</span>
                        <input
                          type="checkbox"
                          role="switch"
                          className={s.switch}
                          checked={p.enabled}
                          onChange={(e) => void save([{ inbox_id: p.inbox_id, enabled: e.currentTarget.checked }])}
                        />
                      </label>
                    ))}
                  </section>

                  <fieldset className={s.settingsGroup}>
                    <legend className={s.helpGroupTitle}>What a notification shows</legend>
                    <label className={s.settingsChoice}>
                      <input type="radio" name={modeName} checked={mode === "rich"} onChange={() => setAll({ payload_mode: "rich" })} />
                      <span>
                        Show sender and subject
                        <span className={s.settingsHint}>Encrypted to this device. Nothing is kept on our servers.</span>
                      </span>
                    </label>
                    <label className={s.settingsChoice}>
                      <input type="radio" name={modeName} checked={mode === "private"} onChange={() => setAll({ payload_mode: "private" })} />
                      <span>
                        Private
                        <span className={s.settingsHint}>Only how many new messages, and in which mailbox.</span>
                      </span>
                    </label>
                  </fieldset>

                  <section className={s.settingsGroup} aria-label="Quiet hours">
                    <h3 className={s.helpGroupTitle}>Quiet hours</h3>
                    <label className={s.settingsRow}>
                      <span className={s.settingsLabel}>No notifications at night</span>
                      <input
                        type="checkbox"
                        role="switch"
                        className={s.switch}
                        checked={quiet !== null}
                        onChange={(e) => setQuiet(e.currentTarget.checked ? DEFAULT_QUIET : null)}
                      />
                    </label>
                    {quiet ? (
                      <div className={s.settingsTimes}>
                        <label>
                          From{" "}
                          <input
                            type="time"
                            value={quiet.start}
                            onChange={(e) => e.currentTarget.value && setQuiet({ start: e.currentTarget.value, end: quiet.end })}
                          />
                        </label>
                        <label>
                          to{" "}
                          <input
                            type="time"
                            value={quiet.end}
                            onChange={(e) => e.currentTarget.value && setQuiet({ start: quiet.start, end: e.currentTarget.value })}
                          />
                        </label>
                        <span className={s.settingsHint}>{quiet.timezone.replace(/_/g, " ")}. Mail that arrives then is not announced later.</span>
                      </div>
                    ) : null}
                  </section>
                </>
              ) : null}
            </>
          )}
        </div>

        <footer className={s.dialogFoot}>
          <Button variant="secondary" size="sm" disabled={busy || !controller || !state?.subscribed} onClick={() => void sendTest()}>
            Send test notification
          </Button>
          <p className={s.dialogNote}>
            {state?.subscribed
              ? "Sends one notification to your own devices."
              : "Turn notifications on for this device to send a test."}
          </p>
        </footer>
      </div>
    </>
  );
}
