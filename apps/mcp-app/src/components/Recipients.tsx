import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  type ContactSource,
  type ContactSuggestion,
  MAX_SUGGESTIONS,
  SUGGEST_MIN_CHARS,
} from "../contacts";

/** How long typing pauses before suggestions are asked for. */
export const SUGGEST_DEBOUNCE_MS = 150;

/**
 * Where a removed chip stood, held open until the pointer leaves the field.
 * `before` is the index of the chip it stands in front of (the list's length
 * when it was last), `width` and `height` the removed chip's own.
 */
interface Ghost {
  key: number;
  before: number;
  width: number;
  height: number;
}

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
 * Removing with the pointer leaves the chips where they were (QA, 2026-10-17).
 * A removed chip used to take its neighbours with it: the next chip slid left
 * under the pointer, so the second click of a double-click, or a quick second
 * click aimed at nothing in particular, removed a recipient nobody chose. The
 * removed chip's place is now held by an invisible spacer of its exact size
 * until the pointer leaves the field (or a key is pressed in it), so whatever
 * is under the pointer after a removal is empty space. The keyboard removal
 * needs none of this: focus moves to a chip, never a pointer.
 *
 * Typing a separator commits (QA, 2026-10-17). A comma, a semicolon or a
 * space after a complete address makes the chip at once, whether it arrived
 * as a key, from an input method or a test tool that inserts text without key
 * events, or as part of a paste. A pasted list (commas, semicolons or one
 * address per line, with or without `Name <address>`) becomes one chip per
 * address; whatever is not an address stays in the input with the caller's
 * warning.
 *
 * Suggestions (2026-10-17). With a `suggest` source, two typed characters ask
 * it for people, debounced, and the answers are a listbox under the field:
 * the input is an ARIA combobox, Up and Down move through them, Enter or a
 * click picks one, Escape closes them. Where they come from is contacts.ts.
 *
 * Up and Down stay among the suggestions (live re-test, 2026-10-17). They used
 * to pass through "the text itself" between the last and the first, so with
 * one suggestion the natural Down deselected it and Enter then committed the
 * partial "bj" as an address. Enter on a partial (no complete address typed)
 * with the list open takes the highlighted suggestion, else the first. The
 * list floats over the rows under the field (`.suggest`), like the "⋯" menu,
 * rather than pushing the card down.
 *
 * A long list folds to one row (live re-test, 2026-10-17). Fourteen recipients
 * made To four rows tall. Until the field is first used, it shows the chips
 * that fit on its first row and a "+N more" button; focus in the field, a
 * press in it or the button opens it, and it folds again only when the frame
 * loses focus, so it never folds under the pointer. Text in the input (and so
 * any warning about it) keeps it open.
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
  /** People to suggest as the person types. None: no suggestions. */
  suggest?: ContactSource;
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

  /** Spacers where chips were removed with the pointer. See the header. */
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const ghostKey = useRef(0);
  const dropGhosts = () => {
    if (ghosts.length > 0) setGhosts([]);
  };
  // A list that changes for any other reason (a save, a resync) is laid out
  // afresh: a spacer only ever stands for the chip this field just removed.
  const expectCount = useRef(n);
  useLayoutEffect(() => {
    if (n !== expectCount.current) setGhosts([]);
    expectCount.current = n;
  }, [n]);

  // ---- a long list folded to its first row (see the header) -----------------
  /** The field has been used since the frame last had focus. */
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const fold = () => setOpened(false);
    window.addEventListener("blur", fold);
    return () => window.removeEventListener("blur", fold);
  }, []);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fold = canEdit && !opened && n > 1 && !props.typed.trim() && !props.invalid;
  /** How many chips fit on the first row, for this list at this width. */
  const foldKey = `${width}|${items.join(",")}|${ghosts.length}`;
  const [fit, setFit] = useState<{ key: string; n: number } | null>(null);
  const shown = fold && fit?.key === foldKey ? fit.n : n;
  const more = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!fold) return;
    const chips = box.current?.querySelectorAll<HTMLElement>(".chip");
    if (!chips || chips.length === 0) return;
    const top = chips[0].offsetTop;
    if (fit?.key !== foldKey) {
      // Every chip is drawn: count the first row's, leaving room for the button.
      let first = 0;
      while (first < chips.length && chips[first].offsetTop <= top + 2) first++;
      setFit({ key: foldKey, n: first >= n ? n : Math.max(1, first - 1) });
    } else if (shown < n && shown > 1) {
      // The button and a "Cc Bcc" link must be on that row too.
      const tail = [more.current, box.current?.querySelector<HTMLElement>(":scope > .link")];
      if (tail.some((el) => el && el.offsetTop > top + 2)) setFit({ key: foldKey, n: shown - 1 });
    }
  });
  const unfold = () => {
    if (!opened) setOpened(true);
  };

  // ---- suggestions -----------------------------------------------------------
  const [sugs, setSugs] = useState<ContactSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  /** Bumped by every ask and every close, so a late answer is dropped. */
  const ask = useRef(0);
  const askTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = `${id}-suggest`;
  const open = sugs.length > 0;
  const closeSugs = () => {
    ask.current++;
    if (askTimer.current !== null) clearTimeout(askTimer.current);
    askTimer.current = null;
    if (sugs.length > 0) setSugs([]);
    setActive(-1);
  };
  useEffect(() => () => {
    if (askTimer.current !== null) clearTimeout(askTimer.current);
  }, []);
  /** The piece being typed: what follows the last comma or semicolon. */
  const lastPiece = (value: string) => value.split(/[,;]/).pop()!.trim();
  /** Whether a piece already reads as a whole address. */
  const whole = (q: string) => /@[^@\s]+\.[^@\s]+$/.test(q);
  const askFor = (value: string) => {
    const q = lastPiece(value);
    const source = props.suggest;
    if (!source || q.length < SUGGEST_MIN_CHARS) {
      closeSugs();
      return;
    }
    const mine = ++ask.current;
    if (askTimer.current !== null) clearTimeout(askTimer.current);
    askTimer.current = setTimeout(() => {
      askTimer.current = null;
      source(q).then(
        (list) => {
          if (mine !== ask.current) return;
          const shown = list.slice(0, MAX_SUGGESTIONS);
          setSugs(shown);
          // Enter takes the first suggestion, unless what is typed is already
          // a whole address: then Enter keeps meaning "this one".
          setActive(shown.length > 0 && !whole(q) ? 0 : -1);
        },
        () => {
          if (mine === ask.current) closeSugs();
        },
      );
    }, SUGGEST_DEBOUNCE_MS);
  };
  /** Take a suggestion: it replaces the piece being typed, and commits. */
  const pick = (s: ContactSuggestion) => {
    const el = input.current;
    const value = el?.value ?? props.typed;
    closeSugs();
    selectRefused.current = true;
    props.onCommit(value.replace(/[^,;]*$/, s.address));
    el?.focus();
  };

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

  /**
   * A key asked to commit what was typed. If text is still in the input once
   * the caller has dealt with it, it was refused (not an address), and it is
   * selected so the next thing typed REPLACES it.
   *
   * QA (2026-10-15): Enter on "not-an-email" left it in the input with the
   * caret at its end, so the next address typed was appended to it and blur
   * then committed the glued `not-an-emailsecond@example.com`, which is a
   * perfectly valid-looking address nobody meant. The refused text stays on
   * screen with its warning (the caller's), so it can still be fixed: an arrow
   * key or a click drops the selection.
   */
  const selectRefused = useRef(false);
  useLayoutEffect(() => {
    if (!selectRefused.current) return;
    selectRefused.current = false;
    const el = input.current;
    if (!el || !el.value.trim() || document.activeElement !== el) return;
    el.select();
  });

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

  const remove = (i: number, then: number | "input", byPointer = false) => {
    if (byPointer) {
      const r = chipAt(i)?.getBoundingClientRect();
      // Spacers already standing after this chip move down one with it.
      const moved = ghosts.map((g) => (g.before > i ? { ...g, before: g.before - 1 } : g));
      setGhosts([
        ...moved,
        { key: ++ghostKey.current, before: i, width: r?.width ?? 0, height: r?.height ?? 0 },
      ]);
    } else {
      dropGhosts();
    }
    expectCount.current = n - 1;
    setArmed(false);
    setSaid(`Removed ${items[i]} from ${label}.`);
    focusNext.current = { to: then, count: n - 1 };
    props.onRemove(i);
  };

  const onInputKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLInputElement;
    if (e.isComposing) return;
    dropGhosts();
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        // Round the suggestions only, never back to "none" (see the header).
        const count = sugs.length;
        setActive((a) => (a < 0 ? (step > 0 ? 0 : count - 1) : (a + step + count) % count));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSugs();
        return;
      }
      if (e.key === "Enter") {
        // A whole address typed with nothing highlighted is "this one"; a
        // partial one is never committed over an open list.
        const i = active >= 0 && active < sugs.length ? active : whole(lastPiece(el.value)) ? -1 : 0;
        if (i >= 0) {
          e.preventDefault();
          pick(sugs[i]);
          return;
        }
      }
      if (e.key === "Tab") closeSugs();
    }
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
    if (e.key !== "Enter" && e.key !== "," && e.key !== ";" && e.key !== " ") return;
    // A space only ends an address at the end of the text, so one typed into
    // the middle of it is still just a space.
    if (e.key === " " && el.selectionStart !== el.value.length) return;
    if (!props.endsAddress(e.key, el.value)) return;
    e.preventDefault();
    closeSugs();
    selectRefused.current = true;
    props.onCommit(el.value);
  };

  /**
   * Every change to the text. A separator that arrived WITHOUT a key event the
   * handler above could stop (an input method, a tool that inserts text, a
   * phone keyboard that reports key 229) is still a separator: when the text
   * now ends in commas, semicolons or spaces after a complete address, that
   * address is committed exactly as the key would have done.
   */
  const onInputText = (el: HTMLInputElement) => {
    const value = el.value;
    const tail = /[\s,;]+$/.exec(value);
    if (tail && value.trim() && el.selectionStart === value.length) {
      const head = value.slice(0, tail.index);
      const key = /[,;]/.test(tail[0]) ? "," : " ";
      if (props.endsAddress(key, head)) {
        closeSugs();
        selectRefused.current = true;
        props.onCommit(head);
        return;
      }
    }
    props.onType(value);
    askFor(value);
  };

  /**
   * A paste that holds a list is committed whole: one chip per address, the
   * rest left in the input. The browser would otherwise drop the line breaks
   * of a one-per-line list and glue the addresses together.
   */
  const onPaste = (e: ClipboardEvent) => {
    const data = e.clipboardData;
    const text = data ? data.getData("text/plain") || data.getData("text") : "";
    const list = /[,;\r\n]/.test(text) || /@\S*\s+\S*@/.test(text.trim());
    if (!text || !list) return;
    e.preventDefault();
    const el = e.target as HTMLInputElement;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const joined = el.value.slice(0, start) + text.replace(/\r\n|\r|\n/g, ", ") + el.value.slice(end);
    closeSugs();
    selectRefused.current = true;
    props.onCommit(joined);
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

  /** A spacer, standing where a chip was. */
  const ghostAt = (g: Ghost) => (
    <span
      class="chip-ghost"
      key={`ghost-${g.key}`}
      aria-hidden="true"
      style={{ width: `${g.width}px`, height: `${g.height}px` }}
    />
  );
  const activeId = open && active >= 0 ? `${listId}-${active}` : undefined;

  return (
    <div class="row">
      <label class="lbl" for={id}>
        {label}
      </label>
      <div
        class="fld"
        id={`${id}-box`}
        ref={box}
        data-folded={shown < n ? "true" : undefined}
        onPointerLeave={dropGhosts}
        onFocusIn={unfold}
        onPointerDown={unfold}
        onClick={(e) => {
          // The box looks like one field, so clicking the empty part of it must
          // put the caret in the input rather than do nothing.
          if (e.target === e.currentTarget) input.current?.focus();
        }}
      >
        {items.slice(0, shown).map((addr, i) => [
          ...ghosts.filter((g) => g.before === i).map(ghostAt),
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
                onClick={() => remove(i, i, true)}
              >
                &#215;
              </button>
            )}
          </span>,
        ])}
        {ghosts.filter((g) => g.before >= n).map(ghostAt)}
        {shown < n && (
          <button
            type="button"
            class="more-chip"
            ref={more}
            // Not a Tab stop: the input is the field's one, and focusing it
            // opens the field anyway.
            tabIndex={-1}
            aria-label={`Show ${n - shown} more ${label} recipients`}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpened(true);
              input.current?.focus();
            }}
          >
            +{n - shown} more
          </button>
        )}
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
          role={props.suggest ? "combobox" : undefined}
          aria-autocomplete={props.suggest ? "list" : undefined}
          aria-expanded={props.suggest ? (open ? "true" : "false") : undefined}
          aria-controls={props.suggest ? listId : undefined}
          aria-activedescendant={activeId}
          // "name@example.com" reads as a value that is already there rather
          // than as an invitation to type one.
          placeholder={n === 0 ? `Add ${label}` : ""}
          value={props.typed}
          disabled={!canEdit}
          aria-invalid={props.invalid ? "true" : undefined}
          aria-describedby={described}
          onInput={(e) => onInputText(e.target as HTMLInputElement)}
          onPaste={(e) => onPaste(e as unknown as ClipboardEvent)}
          onKeyDown={(e) => onInputKey(e as unknown as KeyboardEvent)}
          onBlur={(e) => {
            disarm();
            closeSugs();
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
        {props.trailing}
        {props.suggest && (
          // Anchored to the field's box and floating over the rows under it,
          // like the "⋯" menu: a recipient field always has the subject and
          // the message below it, which are taller than the list.
          <ul class="suggest" id={listId} role="listbox" aria-label={`Suggestions for ${label}`} hidden={!open}>
            {sugs.map((s, i) => (
              <li
                id={`${listId}-${i}`}
                key={s.address}
                role="option"
                aria-selected={i === active ? "true" : "false"}
                // Keep the focus in the input, or its blur would close the list
                // before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(s)}
              >
                {s.name ? (
                  <>
                    <span class="name">{s.name}</span> <span class="muted">{s.address}</span>
                  </>
                ) : (
                  <span class="name">{s.address}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
