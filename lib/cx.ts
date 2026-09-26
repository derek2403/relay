/** Joins the truthy class names; undefined when none, so React omits the attribute. */
export function cx(...names: Array<string | false | null | undefined>): string | undefined {
  return names.filter(Boolean).join(" ") || undefined;
}
