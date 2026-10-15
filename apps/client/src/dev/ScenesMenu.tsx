import { getMockMailApi, getLatency, rememberMockProfile, setFailWrites, setLatencyMode } from "../api/mock";
import type { MockProfile } from "../api/mock";
import { getAssistantPace, setAssistantPace } from "../api/mock/assistant";
import { type MessageKey, makeKey } from "../api/types";
import { clearQueryCache, keys, queryClient } from "../data";
import { clearUndo } from "../data/undo";
import { type RunOptions, revealAssistant, useAssistantStore } from "../state/assistant-store";
import { useComposeStore } from "../state/compose-store";
import { useSelectionStore } from "../state/selection-store";
import { showToast } from "../state/toast-store";
import { useUiStore } from "../state/ui-store";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui";
import s from "./Scenes.module.css";

/* Dev-only "Scenes" menu, ported from the design prototype: start from a
 * profile, or jump straight to a state of the assistant (each jump replays the
 * real scripted run against a fresh mock mailbox). Also pokes the simulators
 * and the mock network. Loaded lazily and only when import.meta.env.DEV or
 * ?scenes. */

/** Time for the lists to load after a profile switch, as in the prototype. */
const SETTLE_MS = 600;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function loadProfile(profile: MockProfile): Promise<void> {
  const assistant = useAssistantStore.getState();
  assistant.stop();
  for (let i = 0; i < 40 && useAssistantStore.getState().busy; i++) await wait(50);
  useComposeStore.getState().discard();
  getMockMailApi().reset(profile);
  rememberMockProfile(profile);
  clearUndo();
  assistant.reset();
  useSelectionStore.getState().openFolder({ role: "inbox" }, "all");
  useSelectionStore.getState().select(null);
  await clearQueryCache();
  void queryClient.invalidateQueries({ queryKey: keys.allowance });
}

/** Key and chip label of a seeded email in the current profile. */
function seeded(id: string): { key: MessageKey; label: string } | null {
  const m = getMockMailApi()
    .allMessages()
    .find((x) => x.id === id);
  return m ? { key: makeKey(m.inbox_id, m.id), label: `${m.from.name} · ${m.subject}` } : null;
}

function ask(text: string, opts: RunOptions, about?: string): Promise<void> {
  const e = about ? seeded(about) : null;
  if (about && !e) {
    showToast("That email is not in this mailbox any more. Pick a profile under Start from.");
    return Promise.resolve();
  }
  // A request about all mail shows in the panel; one about an email shows under it.
  if (!e || useUiStore.getState().viewport !== "phone") revealAssistant();
  return useAssistantStore.getState().run(text, e ? { ...opts, keys: [e.key], contextLabel: e.label } : opts);
}

/** Fresh Pro mailbox, then the request. */
async function jump(text: string, opts: RunOptions, about?: string): Promise<void> {
  await loadProfile("pro");
  await wait(SETTLE_MS);
  await ask(text, opts, about);
}

export default function ScenesMenu() {
  const open = useUiStore((u) => u.menu === "scenes");
  const close = () => useUiStore.getState().setMenu(null);
  const run = (fn: () => void | Promise<void>) => () => {
    close();
    void fn();
  };
  const latency = getLatency();

  return (
    <Menu open={open} onClose={close} label="Prototype scenes" className={s.menu}>
      <MenuLabel>Start from</MenuLabel>
      <MenuItem sub="Gmail just connected. Assistant reads and offers." onSelect={run(() => loadProfile("first"))}>
        First run
      </MenuItem>
      <MenuItem sub="Established user, assistant idle." onSelect={run(() => loadProfile("pro"))}>
        Pro, 3 mailboxes
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Jump to a state</MenuLabel>
      <MenuItem onSelect={run(() => jump("What needs a reply from me?", { intent: "needs" }))}>Row highlighted while read</MenuItem>
      <MenuItem onSelect={run(() => jump("File this week's receipts", { intent: "receipts" }))}>Bulk file with undo</MenuItem>
      <MenuItem
        onSelect={run(async () => {
          await jump("Draft a reply", { intent: "draft" }, "maya");
          await wait(500);
          if (useComposeStore.getState().compose?.ai) await ask("Make it shorter", { intent: "shorter" }, "maya");
        })}
      >
        Draft streams, then edit streams
      </MenuItem>
      <MenuItem onSelect={run(() => jump("Reply that Thursday works, and send it", { intent: "send" }, "maya"))}>
        Held send awaiting approval
      </MenuItem>
      <MenuItem
        sub="Hover the list first to see it held."
        onSelect={run(() => {
          // Delayed so the pointer can get back onto the list.
          setTimeout(() => getMockMailApi().simulateIncoming(), 1500);
          showToast("New mail arrives in 1.5 s");
        })}
      >
        New mail arrives
      </MenuItem>
      <MenuItem
        sub="A reply written in the background asks to go out."
        onSelect={run(async () => {
          const e = seeded("alex");
          if (!e) {
            showToast("Alex's email is not in this mailbox any more. Pick a profile under Start from.");
            return;
          }
          // Nothing is opened: the notice is the only thing that appears.
          await useAssistantStore.getState().run("", { intent: "send_background", keys: [e.key], silent: true, free: true });
        })}
      >
        Push: assistant wants to send
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Simulate</MenuLabel>
      <MenuItem
        onSelect={run(() => {
          const a = getMockMailApi();
          a.setAllowance({ used: 50, cap: 50, remaining: 0 });
          void queryClient.invalidateQueries({ queryKey: keys.allowance });
          showToast("Assistant allowance set to used up");
        })}
      >
        Exhaust the assistant allowance
      </MenuItem>
      <MenuItem trailing={getAssistantPace() === 0 ? "on" : ""} onSelect={run(() => setAssistantPace(getAssistantPace() === 0 ? 1 : 0))}>
        Instant assistant (no typing delay)
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Mock network</MenuLabel>
      <MenuItem trailing={latency.mode === "default" ? "on" : ""} onSelect={run(() => setLatencyMode("default"))}>
        Normal latency
      </MenuItem>
      <MenuItem trailing={latency.mode === "0" ? "on" : ""} onSelect={run(() => setLatencyMode("0"))}>
        No latency
      </MenuItem>
      <MenuItem trailing={latency.mode === "slow" ? "on" : ""} onSelect={run(() => setLatencyMode("slow"))}>
        Slow network
      </MenuItem>
      <MenuItem trailing={latency.failWrites ? "on" : ""} onSelect={run(() => setFailWrites(!getLatency().failWrites))}>
        Writes fail (rollback)
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={run(() => useUiStore.getState().resetLayout())}>Reset layout</MenuItem>
    </Menu>
  );
}
