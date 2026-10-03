import type { Inbox } from "../../api/types";
import type { FolderNavItem } from "../../data/hooks";
import { revealAssistant, useAssistantStore } from "../../state/assistant-store";
import { useSelectionStore } from "../../state/selection-store";
import { useUiStore } from "../../state/ui-store";
import type { Shortcut } from "../shell/keymap";
import { fuzzyScore } from "./fuzzy";

/* What the palette lists, and how a query turns that into sections. Pure apart
 * from the `run` closures, so the section logic is unit-tested (palette.test.ts). */

export type SectionId = "actions" | "goto" | "search" | "ask";

export const SECTION_LABEL: Record<SectionId, string> = {
  actions: "Actions",
  goto: "Go to",
  search: "Search mail",
  ask: "Ask the assistant",
};

export interface PaletteItem {
  id: string;
  section: SectionId;
  label: string;
  /** Extra text the query may match ("go to inbox"). Ranked just below the label. */
  alias?: string;
  /** Right-aligned: a shortcut or a count. */
  hint?: string;
  /** The hint is a key binding: render it as a key cap. */
  hintIsKey?: boolean;
  /** System folder role or "mailbox", for the row icon. */
  icon?: string;
  run: () => void;
}

export interface PaletteSection {
  id: SectionId;
  items: PaletteItem[];
}

/** Rows per section while filtering, and overall. Keeps every keystroke cheap. */
export const SECTION_LIMIT = 8;
export const TOTAL_LIMIT = 50;

export function actionItems(shortcuts: readonly Shortcut[], hint: (s: Shortcut) => string): PaletteItem[] {
  return shortcuts.map((s) => ({
    id: `action:${s.id}`,
    section: "actions",
    label: s.label,
    hint: hint(s),
    hintIsKey: true,
    run: s.run,
  }));
}

export function gotoItems(inboxes: readonly Inbox[], folders: readonly FolderNavItem[]): PaletteItem[] {
  const selection = () => useSelectionStore.getState();
  const items: PaletteItem[] = folders.map((f) => ({
    id: `folder:${f.id}`,
    section: "goto",
    label: f.label,
    alias: `go to ${f.label}`,
    hint: f.count > 0 ? String(f.count) : undefined,
    icon: f.role ?? "folder",
    run: () => selection().openFolder(f.ref),
  }));
  if (inboxes.length > 1) {
    items.push({
      id: "mailbox:all",
      section: "goto",
      label: "All inboxes",
      alias: "go to all inboxes mailbox",
      icon: "mailbox",
      run: () => selection().setScope("all"),
    });
  }
  for (const inbox of inboxes) {
    items.push({
      id: `mailbox:${inbox.inbox_id}`,
      section: "goto",
      label: inbox.email_address,
      alias: `go to mailbox ${inbox.display_name}`,
      icon: "mailbox",
      run: () => selection().setScope(inbox.inbox_id),
    });
  }
  return items;
}

/** The two rows that always follow a typed query. Search comes first on
 *  purpose: when nothing else matches, Enter searches. Asking the assistant
 *  spends allowance, so it is never the accidental default. */
export function queryItems(text: string): PaletteItem[] {
  const q = text.trim();
  if (!q) return [];
  return [
    {
      id: "search",
      section: "search",
      label: `Search for “${q}”`,
      icon: "search",
      run: () => {
        const ui = useUiStore.getState();
        if (ui.viewport === "phone") ui.setScreen("list");
        useSelectionStore.getState().setQuery(q);
      },
    },
    {
      id: "ask",
      section: "ask",
      label: `Ask: ${q}`,
      icon: "ask",
      run: () => {
        revealAssistant();
        void useAssistantStore.getState().run(q);
      },
    },
  ];
}

function scoreItem(query: string, item: PaletteItem): number | null {
  const label = fuzzyScore(query, item.label);
  const alias = item.alias ? fuzzyScore(query, item.alias) : null;
  if (alias == null) return label;
  // An alias match counts, but a label match of the same quality ranks first.
  return label == null ? alias - 100 : Math.max(label, alias - 100);
}

/** Filters and ranks. With an empty query: Actions, then Go to, in their
 *  natural order. With a query: each section sorted by score, the section with
 *  the best match first, then "Search for…" and "Ask: …". */
export function buildSections(query: string, actions: PaletteItem[], gotos: PaletteItem[]): PaletteSection[] {
  const q = query.trim();
  if (!q) {
    const a = actions.slice(0, TOTAL_LIMIT);
    const g = gotos.slice(0, Math.max(0, TOTAL_LIMIT - a.length));
    return [
      { id: "actions" as const, items: a },
      { id: "goto" as const, items: g },
    ].filter((s) => s.items.length > 0);
  }

  const ranked = (id: SectionId, items: PaletteItem[]) => {
    const scored: { item: PaletteItem; score: number; i: number }[] = [];
    items.forEach((item, i) => {
      const score = scoreItem(q, item);
      if (score != null) scored.push({ item, score, i });
    });
    scored.sort((x, y) => y.score - x.score || x.i - y.i);
    const top = scored.slice(0, SECTION_LIMIT);
    return { id, items: top.map((x) => x.item), best: top[0]?.score ?? -1 };
  };

  const matched = [ranked("actions", actions), ranked("goto", gotos)].filter((s) => s.items.length > 0).sort((a, b) => b.best - a.best);
  const [search, ask] = queryItems(q);
  const out: PaletteSection[] = matched.map(({ id, items }) => ({ id, items }));
  if (search) out.push({ id: "search", items: [search] });
  if (ask) out.push({ id: "ask", items: [ask] });
  return out;
}

export function flatten(sections: readonly PaletteSection[]): PaletteItem[] {
  return sections.flatMap((s) => s.items);
}
