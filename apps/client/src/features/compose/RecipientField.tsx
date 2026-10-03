import { X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref, useId, useMemo, useState } from "react";
import type { ContactHit } from "../../api/types";
import { useContacts } from "../../data";
import { cx } from "../../lib/cx";
import s from "./Compose.module.css";
import {
  addRecipients,
  chipsOf,
  isCommitKey,
  isValidAddress,
  looksLikeList,
  moveActive,
  removeRecipientAt,
} from "./recipients";

/* An address line (To / Cc / Bcc): committed addresses as chips, then a
 * combobox input with contact suggestions.
 *
 *   - comma, semicolon, Enter, Tab and blur turn the typed text into a chip;
 *     space does too once the text holds an "@" (before that, space is part of
 *     a name being searched),
 *   - Backspace in an empty input removes the last chip,
 *   - pasting several addresses (or "Name <address>") adds them all,
 *   - arrows move through suggestions, Enter / Tab pick the highlighted one.
 *
 * `value` is the stored comma-separated line; this component never keeps its
 * own copy of the chips.
 */

export interface RecipientFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  placeholder?: string;
  /** Rendered at the end of the row (the "Cc Bcc" toggle). */
  trailing?: ReactNode;
}

const MAX_SUGGESTIONS = 6;

export function RecipientField({ label, value, onChange, inputRef, placeholder, trailing }: RecipientFieldProps) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputId = useId();
  const listId = useId();

  const chips = useMemo(() => chipsOf(value), [value]);
  const query = open ? text.trim() : "";
  const { data } = useContacts(query);

  const options = useMemo(() => {
    if (!query) return [];
    const taken = new Set(chips.map((c) => c.toLowerCase()));
    const out: ContactHit[] = [];
    for (const hit of data ?? []) {
      const k = hit.email_address.toLowerCase();
      if (taken.has(k)) continue;
      taken.add(k);
      out.push(hit);
      if (out.length === MAX_SUGGESTIONS) break;
    }
    return out;
  }, [data, chips, query]);

  const showList = open && options.length > 0;
  // Until the user arrows, the first suggestion is the one Enter picks,
  // unless what they typed is already a complete address.
  const current = !showList ? -1 : active >= 0 && active < options.length ? active : isValidAddress(text) ? -1 : 0;
  const optionId = (i: number) => `${listId}-${i}`;

  const reset = () => {
    setText("");
    setActive(-1);
    setOpen(false);
  };
  const commit = (raw: string) => {
    const next = addRecipients(value, raw);
    if (next !== value) onChange(next);
    reset();
  };
  const removeAt = (i: number) => onChange(removeRecipientAt(value, i));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const typed = text.trim();
    // Send shortcut: commit what is typed, then let the form handle the key.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      if (typed) commit(typed);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (showList) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive(moveActive(current, options.length, e.key === "ArrowDown" ? "next" : "prev"));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && current >= 0) {
        const hit = options[current];
        if (hit) {
          e.preventDefault();
          commit(hit.email_address);
          return;
        }
      }
      if (e.key === "Escape") {
        // Closes the suggestions only; the form's own Escape comes next.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setActive(-1);
        return;
      }
    }
    if (e.key === "Tab") {
      if (typed) commit(typed); // and let focus move on
      return;
    }
    if (isCommitKey(e.key)) {
      if (e.key === " " && !typed.includes("@")) return;
      if (typed) {
        e.preventDefault();
        commit(typed);
      } else if (e.key !== "Enter") {
        e.preventDefault(); // a stray separator
      }
      return;
    }
    if (e.key === "Backspace" && text === "" && chips.length) {
      e.preventDefault();
      removeAt(chips.length - 1);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!looksLikeList(pasted)) return;
    e.preventDefault();
    commit(`${text} ${pasted}`);
  };

  return (
    <div className={s.field}>
      <label className={s.fieldLabel} htmlFor={inputId}>
        {label}
      </label>
      <div className={s.chips}>
        {chips.map((address, i) => {
          const valid = isValidAddress(address);
          return (
            <span
              key={`${address}-${i}`}
              className={cx(s.chip, !valid && s.chipInvalid)}
              title={valid ? address : `${address} does not look like an email address`}
            >
              <span className={s.chipText}>{address}</span>
              {!valid ? <span className="sr-only"> (not a valid address)</span> : null}
              <button
                type="button"
                className={s.chipRemove}
                aria-label={`Remove ${address}`}
                onClick={() => removeAt(i)}
                // Keeps focus (and the caret) in the input.
                onMouseDown={(e) => e.preventDefault()}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          id={inputId}
          className={s.chipInput}
          type="text"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          value={text}
          placeholder={chips.length ? undefined : placeholder}
          onChange={(e) => {
            const v = e.target.value;
            // Soft keyboards do not always send a key for separators.
            if (/[,;]$/.test(v) && v.slice(0, -1).trim()) {
              commit(v.slice(0, -1));
              return;
            }
            setText(v);
            setActive(-1);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            if (text.trim()) commit(text);
            else setOpen(false);
          }}
        />
      </div>
      {trailing}
      <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className={s.suggestions} hidden={!showList}>
        {showList
          ? options.map((hit, i) => (
              <li
                key={hit.email_address}
                id={optionId(i)}
                role="option"
                aria-selected={i === current}
                className={cx(s.suggestion, i === current && s.suggestionActive)}
                // mousedown, not click: the input must not blur (and commit) first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(hit.email_address);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {hit.display_name ? <span className={s.suggestionName}>{hit.display_name}</span> : null}
                <span className={s.suggestionAddr}>{hit.email_address}</span>
              </li>
            ))
          : null}
      </ul>
    </div>
  );
}
