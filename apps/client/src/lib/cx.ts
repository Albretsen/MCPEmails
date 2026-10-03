export type ClassValue = string | false | null | undefined | 0;

/** Joins truthy class names. */
export function cx(...parts: ClassValue[]): string {
  let out = "";
  for (const p of parts) if (p) out = out ? `${out} ${p}` : p;
  return out;
}
