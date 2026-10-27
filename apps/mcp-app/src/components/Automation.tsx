import { useEffect, useRef, useState } from "preact/hooks";
import type { ToolResultParams } from "../bridge";
import { errorText } from "../bridge";
import type { AutomationSeed } from "../plain-result";
import { neutralizeDeep } from "../sanitize";
import { Head, Line, Notice, Segmented } from "./ui";

// ---------------------------------------------------------------------------
// The automation card: one stored rule in a plain sentence, what it would match
// right now, and one switch. No editing; the model edits rules.
//
// It mounts on a PLAIN `automation` / `automation_read` result (the model's
// result is unchanged, see mcp-server/mcp-app-automation.ts), so it owns its
// own state instead of an envelope: the seed from the result, then one
// `card_automation` call for the rest. The switch goes through the same tool,
// and the next model read of the rule (`automation_read`) reads the stored
// state, which is the only channel to the model that works in Claude
// (update-model-context is acknowledged and never shown to it).
// ---------------------------------------------------------------------------

interface Rule extends AutomationSeed {
  name?: string;
  enabled?: boolean;
  sentence?: string;
  inbox?: string | null;
  note?: string | null;
  preview_failed?: boolean;
}

export function Automation(props: {
  seed: AutomationSeed;
  call: (args: Record<string, unknown>) => Promise<ToolResultParams>;
}) {
  const [rule, setRule] = useState<Rule>(props.seed);
  // A ref, not state: two clicks in one frame both see the old state.
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const go = (args: Record<string, unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    props
      .call({ automation_id: props.seed.id, ...args })
      .then((r) => {
        const next = !r.isError && r.structuredContent?.automation;
        if (next) setRule((prev) => ({ ...prev, ...neutralizeDeep(next) }));
        else setError(r.content?.find((c) => c?.type === "text")?.text || "Could not reach MCPEmails.");
      }, (e) => setError(errorText(e)))
      .finally(() => (busy.current = false));
  };

  // A preview result already carries the dry run, so only the rule is asked for.
  useEffect(() => {
    if (props.seed.id) go(props.seed.matches ? { preview: false } : {});
  }, []);

  // At most 200 (the per-run cap), so no thousands separator to format.
  const n = rule.matched;
  return (
    <>
      <Head
        tone={rule.enabled ? "success" : "neutral"}
        title={rule.name || (props.seed.id ? "Automation" : "Dry run")}
      >
        {rule.sentence && (
          <Segmented
            label="Automation"
            options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]}
            value={rule.enabled ? "on" : "off"}
            onChange={(v) => {
              if ((v === "on") !== rule.enabled) go({ enabled: v === "on" });
            }}
          />
        )}
      </Head>
      {rule.sentence && <Line>{rule.sentence}{rule.inbox ? ` In ${rule.inbox}.` : ""}</Line>}
      {rule.note && <Notice tone="warning">{rule.note}</Notice>}
      {n === 0 && <Line>Nothing in this inbox matches right now.</Line>}
      {!!n && (
        <>
          <Line>{n}{rule.capped ? "+" : ""} {n === 1 ? "message matches" : "messages match"} right now:</Line>
          <ul class="samples">
            {(rule.matches ?? []).map((m, i) => (
              <li key={i}>
                <span class="s-from">{m.from || "(unknown sender)"}</span>
                <span class="s-subject">{m.subject || "(no subject)"}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {rule.preview_failed && n === undefined && <Line>Could not check what it matches right now.</Line>}
      {error && <Notice tone="danger">{error}</Notice>}
    </>
  );
}
