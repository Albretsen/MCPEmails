import { type AssistantAllowance, allowanceFraction, formatAllowance } from "../../api/types";

/* Pure derivations for the sidebar. */

/** From this share of the monthly allowance the meter turns amber. */
export const ALLOWANCE_WARN_AT = 0.8;

export interface AllowanceView {
  /** "312 / 1,000", or "312 used" when the plan has no cap. */
  text: string;
  /** 0..1 for the meter. null = no cap, so there is nothing to measure against. */
  fraction: number | null;
  tone: "normal" | "warn";
  /** Spoken value of the meter. */
  valueText: string;
}

/** A null cap means unlimited and is never turned into a number or a bar. */
export function allowanceView(a: Pick<AssistantAllowance, "used" | "cap">): AllowanceView {
  const fraction = allowanceFraction(a);
  const used = a.used.toLocaleString("en-US");
  return {
    text: formatAllowance(a),
    fraction,
    tone: fraction != null && fraction >= ALLOWANCE_WARN_AT ? "warn" : "normal",
    valueText:
      a.cap == null
        ? `${used} assistant actions used, no monthly limit`
        : `${used} of ${a.cap.toLocaleString("en-US")} assistant actions used`,
  };
}

/** Text for assistive tech after a nav item's name: ", 3 unread" / ", 12 emails". */
export function countSuffix(count: number, kind: "unread" | "total"): string {
  if (count <= 0) return "";
  const n = count.toLocaleString("en-US");
  return kind === "unread" ? `, ${n} unread` : `, ${n} ${count === 1 ? "email" : "emails"}`;
}
