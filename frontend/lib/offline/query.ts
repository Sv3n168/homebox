// Local, in-browser versions of the entity read endpoints. Used when the
// server can't be reached: they evaluate the same query parameters the UI
// sends to GET /v1/entities (and friends) against the offline snapshot, so
// lists, search, location pages and QR lookups keep working in the basement.
//
// The semantics follow backend/internal/data/repo/repo_entities.go
// (QueryByGroup, applyEntityOrder). Full-text search is approximated with a
// case-insensitive "every word must appear somewhere" match.

import type { EntityOut, EntityPath, EntitySummary, EntityTypeSummary, TagSummary } from "../api/types/data-contracts";

/** Marker the UI uses to show "not synced yet" on entities created offline. */
export const PENDING_FLAG = "_offlinePending";

export type PendingEntity = EntityOut & { [PENDING_FLAG]?: true };

export type ListResult = {
  page: number;
  pageSize: number;
  total: number;
  items: EntitySummary[];
};

/** Lookup for details we may have cached, to widen what search matches. */
export type DetailLookup = (id: string) => Partial<EntityOut> | undefined;

function isLocation(e: EntitySummary): boolean {
  return !!e.entityType?.isLocation;
}

function bool(params: URLSearchParams, key: string): boolean {
  const v = params.get(key);
  return v === "true" || v === "1";
}

function int(params: URLSearchParams, key: string, fallback: number): number {
  const v = params.get(key);
  if (v === null || v === "") return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

/** "000-123", "#123", "123" -> 123; anything else -> null. */
export function parseAssetId(value: string | null | undefined): number | null {
  if (!value) return null;
  const digits = value.replace(/^#/, "").replace(/-/g, "").trim();
  if (!/^\d+$/.test(digits)) return null;
  return parseInt(digits, 10);
}

function searchText(e: EntitySummary, details: DetailLookup | undefined): string {
  const d = details?.(e.id);
  const parts: Array<string | undefined | null> = [
    e.name,
    e.description,
    e.assetId,
    e.lentTo,
    ...(e.tags ?? []).map(t => t.name),
    d?.serialNumber,
    d?.modelNumber,
    d?.manufacturer,
    d?.notes,
    d?.purchaseFrom,
    ...(d?.fields ?? []).map(f => f.textValue),
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function matchesSearch(e: EntitySummary, q: string, details: DetailLookup | undefined): boolean {
  const trimmed = q.trim();
  if (trimmed === "") return true;

  // "#123" looks up by asset ID, like the server does.
  if (/^#\d[\d-]*$/.test(trimmed)) {
    return parseAssetId(e.assetId) === parseAssetId(trimmed);
  }

  const haystack = searchText(e, details);
  const phrases = [...trimmed.matchAll(/"([^"]+)"|(\S+)/g)].map(m => (m[1] ?? m[2] ?? "").toLowerCase());
  return phrases.every(p => haystack.includes(p));
}

/** Where an entity is stored: its own location override, else its parent. */
function effectiveLocationId(e: EntitySummary, details: DetailLookup | undefined): string | undefined {
  return details?.(e.id)?.locationId ?? e.parent?.id ?? undefined;
}

function compare(a: EntitySummary, b: EntitySummary, orderBy: string): number {
  const str = (x: unknown) => String(x ?? "");
  const time = (x: Date | string) => new Date(x).getTime() || 0;
  switch (orderBy) {
    case "createdAt":
      return time(a.createdAt) - time(b.createdAt);
    case "updatedAt":
      return time(a.updatedAt) - time(b.updatedAt);
    case "assetId":
      return (parseAssetId(a.assetId) ?? 0) - (parseAssetId(b.assetId) ?? 0);
    case "quantity":
      return a.quantity - b.quantity;
    case "insured":
      return Number(a.insured) - Number(b.insured);
    case "archived":
      return Number(a.archived) - Number(b.archived);
    case "purchasePrice":
      return a.purchasePrice - b.purchasePrice;
    case "location":
      return str(a.parent?.name).localeCompare(str(b.parent?.name));
    default:
      return str(a.name).localeCompare(str(b.name));
  }
}

/** GET /v1/entities evaluated locally. `all` holds items and locations. */
export function queryEntities(all: EntitySummary[], params: URLSearchParams, details?: DetailLookup): ListResult {
  const entityTypeIds = params.getAll("entityTypeIds");
  const parentIds = params.getAll("parentIds");
  const parentItemIds = params.getAll("parentItemIds");
  const tagIds = params.getAll("tags");
  const isLoc = params.get("isLocation");
  const q = params.get("q") ?? "";
  const negateTags = bool(params, "negateTags");
  const matchAllTags = bool(params, "matchAllTags");

  let rows = all.filter(e => {
    if (entityTypeIds.length > 0) {
      if (!e.entityType || !entityTypeIds.includes(e.entityType.id)) return false;
    } else if (isLoc !== null && isLoc !== "" && (isLoc === "true" || isLoc === "1")) {
      if (!isLocation(e)) return false;
    } else if (isLocation(e)) {
      return false;
    }

    if (bool(params, "filterChildren") && e.parent) return false;
    if (!bool(params, "includeArchived") && e.archived) return false;
    if (bool(params, "onlyLent") && !(e.lentTo && e.lentTo.trim() !== "")) return false;
    if (bool(params, "onlyWithoutTags") && (e.tags ?? []).length > 0) return false;
    if (bool(params, "onlyWithPhoto") && !e.imageId) return false;
    if (bool(params, "onlyWithoutPhoto") && e.imageId) return false;

    if (tagIds.length > 0) {
      const own = new Set((e.tags ?? []).map(t => t.id));
      if (negateTags) {
        if (tagIds.some(id => own.has(id))) return false;
      } else if (matchAllTags) {
        if (!tagIds.every(id => own.has(id))) return false;
      } else if (!tagIds.some(id => own.has(id))) {
        return false;
      }
    }

    if (parentIds.length > 0) {
      const loc = effectiveLocationId(e, details);
      if (!loc || !parentIds.includes(loc)) return false;
    }
    if (parentItemIds.length > 0 && !(e.parent && parentItemIds.includes(e.parent.id))) return false;

    return matchesSearch(e, q, details);
  });

  // Locations carry the summed quantity of the items directly inside them.
  if (isLoc === "true" || isLoc === "1") {
    rows = rows.map(loc => ({
      ...loc,
      itemCount: all
        .filter(c => !isLocation(c) && !c.archived && c.parent?.id === loc.id)
        .reduce((sum, c) => sum + (c.quantity || 0), 0),
    }));
  }

  const orderBy = params.get("orderBy") ?? "";
  const direction = params.get("orderDirection") ?? "";
  const defaultDesc = orderBy === "createdAt" || orderBy === "updatedAt";
  const desc = direction === "desc" || (direction === "" && defaultDesc);
  rows.sort((a, b) => (desc ? -1 : 1) * compare(a, b, orderBy));

  const page = int(params, "page", -1);
  const pageSize = int(params, "pageSize", -1);
  const total = rows.length;
  if (page !== -1 || pageSize !== -1) {
    const size = pageSize > 0 ? pageSize : total;
    const offset = Math.max(0, ((page > 0 ? page : 1) - 1) * size);
    rows = rows.slice(offset, offset + size);
  }

  return { page, pageSize, total, items: rows };
}

export type PendingMove = { entityId: string; parentId: string };

/**
 * Applies moves made offline to the snapshot, in order, so lists, paths and
 * box contents already show the new place. Unknown targets are skipped.
 */
export function applyMoves(all: EntitySummary[], moves: PendingMove[]): EntitySummary[] {
  if (moves.length === 0) return all;
  const byId = new Map(all.map(e => [e.id, e]));
  for (const m of moves) {
    const e = byId.get(m.entityId);
    const target = byId.get(m.parentId);
    if (!e || !target) continue;
    byId.set(e.id, { ...e, parent: { ...target, parent: target.parent } });
  }
  return all.map(e => byId.get(e.id)!);
}

/** GET /v1/assets/{id}: entities carrying that asset ID. */
export function queryAsset(all: EntitySummary[], assetId: string): ListResult {
  const wanted = parseAssetId(assetId);
  const items = wanted === null ? [] : all.filter(e => parseAssetId(e.assetId) === wanted);
  return { page: 1, pageSize: items.length, total: items.length, items };
}

/** GET /v1/entities/{id}/path: root first, the entity itself last. */
export function entityPath(all: EntitySummary[], id: string): EntityPath[] | null {
  const byId = new Map(all.map(e => [e.id, e]));
  let cur = byId.get(id);
  if (!cur) return null;

  const path: EntityPath[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift({
      id: cur.id,
      name: cur.name,
      type: (isLocation(cur) ? "location" : "item") as EntityPath["type"],
    });
    cur = cur.parent ? (byId.get(cur.parent.id) ?? undefined) : undefined;
  }
  return path;
}

/**
 * The best EntityOut we can offer offline when the detail response itself
 * was never cached: everything the summary knows, empty defaults elsewhere.
 */
export function entityFromSummary(s: EntitySummary, all: EntitySummary[]): EntityOut {
  const children = all.filter(c => c.parent?.id === s.id && isLocation(c));
  const location = s.parent && isLocation(s.parent) ? s.parent : null;
  return {
    ...s,
    location,
    attachments: [],
    fields: [],
    children,
    lifetimeWarranty: false,
    manufacturer: "",
    modelNumber: "",
    notes: "",
    purchaseDate: "",
    purchaseFrom: "",
    serialNumber: "",
    soldNotes: "",
    soldPrice: 0,
    soldTo: "",
    syncChildEntityLocations: false,
    totalPrice: 0,
    warrantyDetails: "",
    warrantyExpires: "",
  } as EntityOut;
}

export type CreateBody = {
  name?: string;
  description?: string;
  quantity?: number;
  parentId?: string | null;
  locationId?: string | null;
  entityTypeId?: string;
  tagIds?: string[];
  manufacturer?: string | null;
  modelNumber?: string | null;
};

/** What a queued POST /v1/entities will look like once the server has it. */
export function entityFromCreate(
  tempId: string,
  body: CreateBody,
  queuedAt: string,
  ctx: { all: EntitySummary[]; tags: TagSummary[]; entityTypes: EntityTypeSummary[] }
): PendingEntity {
  const parent = body.parentId ? (ctx.all.find(e => e.id === body.parentId) ?? null) : null;
  const entityType = ctx.entityTypes.find(t => t.id === body.entityTypeId) ?? null;
  const tags = (body.tagIds ?? []).map(id => ctx.tags.find(t => t.id === id)).filter((t): t is TagSummary => !!t);

  const summary: EntitySummary = {
    id: tempId,
    name: body.name ?? "",
    description: body.description ?? "",
    quantity: body.quantity ?? 1,
    assetId: "",
    archived: false,
    insured: false,
    createdAt: queuedAt,
    updatedAt: queuedAt,
    entityType,
    parent: parent ? { ...parent, parent: undefined } : null,
    tags,
    imageId: null,
    thumbnailId: null,
    itemCount: 0,
    purchasePrice: 0,
    soldDate: "",
    lentTo: "",
    lentDate: "",
    lentReturnDate: "",
  };

  return {
    ...entityFromSummary(summary, ctx.all),
    manufacturer: body.manufacturer ?? "",
    modelNumber: body.modelNumber ?? "",
    locationId: body.locationId ?? undefined,
    [PENDING_FLAG]: true,
  };
}
