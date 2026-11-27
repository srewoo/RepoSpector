/** A place in the new version of a file. */
export interface Site {
  readonly file: string;
  readonly line: number;
}

type Foldable = { readonly file: string; readonly line: number; readonly confidence?: number | undefined };

/** Valid links only: backwards, in range, to an item that is not itself linked. No self links, chains or cycles. */
function groupsOf(count: number, sameAs: ReadonlyMap<number, number>): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  for (const [i, head] of [...sameAs].sort((a, b) => a[0] - b[0])) {
    if (i >= count || head >= i || sameAs.has(head)) continue;
    groups.set(head, [...(groups.get(head) ?? [head]), i]);
  }
  return groups;
}

/**
 * Folds findings the verifier marked as the same root cause into one. The member with the highest
 * confidence becomes the head and lists the other sites in alsoAt; it takes the place of the group's
 * first member. Nothing is lost: every site stays listed.
 */
export function foldSameCause<T extends Foldable>(items: readonly T[], sameAs: ReadonlyMap<number, number>): (T & { alsoAt?: Site[] })[] {
  const groups = groupsOf(items.length, sameAs);
  const members = new Set([...groups.values()].flatMap((g) => g.slice(1)));
  const out: (T & { alsoAt?: Site[] })[] = [];
  items.forEach((item, i) => {
    if (members.has(i)) return;
    const group = groups.get(i);
    if (!group) {
      out.push(item);
      return;
    }
    const conf = (k: number): number => items[k]?.confidence ?? -1;
    const best = group.reduce((a, b) => (conf(b) > conf(a) ? b : a));
    const head = items[best] as T;
    const alsoAt = group.filter((k) => k !== best).map((k) => ({ file: (items[k] as T).file, line: (items[k] as T).line }));
    out.push({ ...head, alsoAt });
  });
  return out;
}
