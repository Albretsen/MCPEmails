import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

/**
 * One recipient row of the draft editor: a label and ONE bordered box that
 * holds both the chips and the input.
 *
 * The keyboard model (QA, 2026-10-13). The input is the field's only Tab stop,
 * so a long list is one stop rather than one per recipient:
 *
 *   - Left at the start of the input moves onto the last chip. Left and Right
 *     move between chips, Home goes to the first, Right from the last chip and
 *     End and Escape go back to the input.
 *   - Delete or Backspace on a focused chip removes it. Focus goes to the chip
 *     that takes its place (Delete) or the one before (Backspace), else to the
 *     input, never to the document.
 *   - Typing on a focused chip goes to the input.
 *   - Backspace in an EMPTY input takes two presses: the first marks the last
 *     chip and says so, the second removes it. Any other key, or leaving the
 *     field, clears the mark. A held Backspace never reaches the chips, so
 *     deleting typed text cannot run on into the recipients.
 *
 * The remove button on each chip stays for the pointer and for a screen
 * reader's browse mode, with `tabindex="-1"`.
 *
 * What is in the list, and what typed text becomes, is the caller's business:
 * this component owns focus, the mark and the announcements, nothing else.
 */
export function RecipientField(props: {
  /** The input's id. The box is `${id}-box`. */
  id: string;
  /** "To", "Cc" or "Bcc". */
  label: string;
  items: string[];
  typed: string;
  canEdit: boolean;
  invalid: boolean;
  /** The id of the warning about this field, when there is one. */
  describedBy?: string;
  /** Whether `key`, pressed at the end of `value`, finishes an address. */
  endsAddress: (key: string, value: string) => boolean;
  onType: (value: string) => void;
  onCommit: (value: string) => void;
  onRemove: (index: number) => void;
  trailing?: ComponentChildren;
}) {
  const { id, label, items, canEdit } = props;
  const n = items.length;
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** The last chip is marked: the next Backspace in the input removes it. */
  const [armed, setArmed] = useState(false);
  /** The live region's text. */
  const [said, setSaid] = useState("");
  /**
   * Where focus goes once the list has re-rendered without the removed chip: a
   * chip index, or the input. `count` is the length to wait for, so a render
   * that still has the old list does not spend it on a chip about to go.
   */
  const focusNext = useRef<{ to: number | "input"; count: number } | null>(null);

  const chipAt = (i: number) =>
    box.current?.querySelectorAll<HTMLElement>(".chip")[i] ?? null;
  const toInput = () => {
    const el = input.current;
    if (!el) return;
    el.focus();
    try {
      el.setSelectionRange(0, 0);
    } catch {
      /* not every input type has a caret to place */
    }
  };

  useLayoutEffect(() => {
    const f = focusNext.current;
    if (f === null || f.count !== n) return;
    focusNext.current = null;
    const chip = f.to === "input" ? null : chipAt(Math.min(f.to, n - 1));
    if (chip) chip.focus();
    else input.current?.focus();
  });

  /** Take the mark off, and its sentence with it, so marking again is said again. */
  const disarm = () => {
    if (!armed) return;
    setArmed(false);
    setSaid("");
  };

  const remove = (i: number, then: number | "input") => {
    setArmed(false);
    setSaid(`Removed ${items[i]} from ${label}.`);
    focusNext.current = { to: then, count: n - 1 };
    props.onRemove(i);
  };

  const onInputKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLInputElement;
    if (e.isComposing) return;
    if (e.key === "Backspace" && el.value === "" && n > 0) {
      e.preventDefault();
      if (e.repeat) return;
      if (armed) {
        remove(n - 1, "input");
      } else {
        setArmed(true);
        setSaid(`${items[n - 1]} selected. Press Backspace again to remove it.`);
      }
      return;
    }
    disarm();
    if (e.key === "ArrowLeft" && n > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      chipAt(n - 1)?.focus();
      return;
    }
    if (e.key !== "Enter" && e.key !== "," && e.key !== " ") return;
    // A space only ends an address at the end of the text, so one typed into
    // the middle of it is still just a space.
    if (e.key === " " && el.selectionStart !== el.value.length) return;
    if (!props.endsAddress(e.key, el.value)) return;
    e.preventDefault();
    props.onCommit(el.value);
  };

  const onChipKey = (i: number, e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const go = (to: number | "input") => {
      e.preventDefault();
      if (to === "input") toInput();
      else chipAt(to)?.focus();
    };
    if (e.key === "ArrowLeft") go(Math.max(0, i - 1));
    else if (e.key === "ArrowRight") go(i < n - 1 ? i + 1 : "input");
    else if (e.key === "Home") go(0);
    else if (e.key === "End" || e.key === "Escape") go("input");
    else if (e.key === "Delete") {
      e.preventDefault();
      remove(i, i < n - 1 ? i : "input");
    } else if (e.key === "Backspace") {
      e.preventDefault();
      remove(i, n === 1 ? "input" : Math.max(0, i - 1));
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Not prevented: with focus moved, the character lands in the input.
      input.current?.focus();
    }
  };

  const hint = n > 0 && canEdit ? `${id}-hint` : undefined;
  const described = [props.describedBy, hint].filter(Boolean).join(" ") || undefined;

  return (
    <div class="row">
      <label class="lbl" for={id}>
        {label}
      </label>
      <div
        class="fld"
        id={`${id}-box`}
        ref={box}
        onClick={(e) => {
          // The box looks like one field, so clicking the empty part of it must
          // put the caret in the input rather than do nothing.
          if (e.target === e.currentTarget) input.current?.focus();
        }}
      >
        {items.map((addr, i) => (
          <span
            class="chip"
            key={`${addr}-${i}`}
            role="group"
            aria-roledescription="recipient"
            aria-label={`${addr}, ${i + 1} of ${n} in ${label}`}
            aria-describedby={canEdit ? `${id}-chip-hint` : undefined}
            title={addr}
            tabIndex={canEdit ? -1 : undefined}
            data-armed={armed && i === n - 1 ? "true" : undefined}
            onKeyDown={canEdit ? (e) => onChipKey(i, e as unknown as KeyboardEvent) : undefined}
          >
            <span class="name">{addr}</span>
            {canEdit && (
              <button
                type="button"
                class="chip-x"
                tabIndex={-1}
                aria-label={`Remove ${addr}`}
                onClick={() => remove(i, i)}
              >
                &#215;
              </button>
            )}
          </span>
        ))}
        <input
          id={id}
          ref={input}
          // Not type="email": that type has no caret position to read (Left at
          // the start of the text is how the chips are reached) and trims what
          // is typed. `inputmode` keeps the email keyboard on a phone.
          type="text"
          inputMode="email"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          aria-label={`${label} recipients`}
          // "name@example.com" reads as a value that is already there rather
          // than as an invitation to type one.
          placeholder={n === 0 ? `Add ${label}` : ""}
          value={props.typed}
          disabled={!canEdit}
          aria-invalid={props.invalid ? "true" : undefined}
          aria-describedby={described}
          onInput={(e) => props.onType((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => onInputKey(e as unknown as KeyboardEvent)}
          onBlur={(e) => {
            disarm();
            const el = e.target as HTMLInputElement;
            if (el.value.trim()) props.onCommit(el.value);
          }}
        />
        {hint && (
          <span class="sr-only" id={hint}>
            {n === 1 ? "1 recipient" : `${n} recipients`} added. Press Left arrow to move to them.
          </span>
        )}
        {canEdit && n > 0 && (
          <span class="sr-only" id={`${id}-chip-hint`}>
            Press Delete to remove. Left and Right arrows move between recipients.
          </span>
        )}
        <span class="sr-only" role="status">
          {said}
        </span>
      </div>
      {props.trailing}
    </div>
  );
}
