// Finding likely duplicates by name, and what merging them means.

import type { EntityOut, EntitySummary, EntityUpdate } from "../api/types/data-contracts";

/** "Akku-Schrauber (Bosch)" and "akkuschrauber bosch" compare equal. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 1 = same name, 0 = nothing in common. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // Very short names ("Box", "Kabel") only count when identical.
  if (Math.min(x.length, y.length) < 5) return 0;
  const max = Math.max(x.length, y.length);
  if (Math.abs(x.length - y.length) / max > 0.25) return 0;
  return 1 - levenshtein(x, y) / max;
}

export const SIMILAR = 0.9;

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Groups of entities that are probably the same thing. Pairs the user marked
 * as "not a duplicate" are ignored.
 */
export function findDuplicateGroups(
  items: EntitySummary[],
  ignoredPairs: Set<string> = new Set(),
  threshold = SIMILAR
): EntitySummary[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (ignoredPairs.has(pairKey(a.id, b.id))) continue;
      if (nameSimilarity(a.name, b.name) >= threshold) {
        parent[find(i)] = find(j);
      }
    }
  }

  const groups = new Map<number, EntitySummary[]>();
  items.forEach((item, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });
  return [...groups.values()].filter(g => g.length > 1).sort((a, b) => b.length - a.length);
}

/** Existing items whose name is close to what is being typed. */
export function similarItems(name: string, items: EntitySummary[], threshold = SIMILAR): EntitySummary[] {
  return items
    .map(item => ({ item, score: nameSimilarity(name, item.name) }))
    .filter(x => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map(x => x.item);
}

/** The full update payload for an entity as it is now (for PUT). */
export function entityToUpdate(e: EntityOut): EntityUpdate {
  return {
    ...(e as unknown as EntityUpdate),
    parentId: e.parent?.id ?? null,
    locationId: e.locationId ?? null,
    tagIds: (e.tags ?? []).map(t => t.id),
    entityTypeId: e.entityType?.id ?? "",
    purchasePrice: e.purchasePrice || 0,
    soldPrice: e.soldPrice || 0,
    fields: e.fields ?? [],
  };
}

/** What the kept entry looks like after absorbing the others. */
export function mergeInto(target: EntityOut, others: EntityOut[]): EntityUpdate {
  const update = entityToUpdate(target);
  update.quantity = [target, ...others].reduce((sum, e) => sum + (e.quantity || 0), 0);
  update.tagIds = [...new Set([target, ...others].flatMap(e => (e.tags ?? []).map(t => t.id)))];
  const notes = [target.notes, ...others.map(o => o.notes)].map(n => (n ?? "").trim()).filter(Boolean);
  update.notes = [...new Set(notes)].join("\n\n").slice(0, 1000);
  for (const field of ["description", "manufacturer", "modelNumber", "serialNumber"] as const) {
    if (!update[field]) update[field] = others.find(o => o[field])?.[field] ?? "";
  }
  return update;
}
