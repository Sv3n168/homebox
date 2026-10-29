// The bridge between lib/requests and offline mode. Requests calls into this
// for every API call made through useUserApi():
//
//  - successful JSON GETs are remembered (IndexedDB "responses")
//  - when the server can't be reached, GETs are answered locally: entity
//    lists/search/asset lookups from the snapshot, everything else from the
//    remembered responses
//  - creating entities and uploading their photos is queued in the outbox and
//    answered with a pending entity, so the create dialog just works offline
//  - moves, quantity/tag edits and box-check fields are queued the same way
//  - every other write is refused with a clear offline error

import type { EntitySummary, EntityTypeSummary, TagSummary } from "../api/types/data-contracts";
import {
  applyMoves,
  applyPatches,
  entityFromCreate,
  entityFromSummary,
  entityPath,
  queryAsset,
  queryEntities,
  type CreateBody,
  type PendingEntity,
  type PendingMove,
  type PendingPatch,
} from "./query";
import {
  addOutbox,
  getIdMap,
  getEntityDetails,
  getResponse,
  getSnapshot,
  listOutbox,
  offlineStorageAvailable,
  putResponse,
  type OutboxCreate,
  type OutboxField,
  type OutboxMove,
  type OutboxPatch,
  type OutboxTag,
} from "./store";
import { offlineState, rememberOnline } from "./state";

export const OFFLINE_ID_PREFIX = "offline-";
const RESERVED_ENTITY_PATHS = new Set(["tree", "fields", "export", "import"]);
const API = "/api/v1";

export type OfflineRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  data?: FormData;
  /** The request went out and failed; the server may have received it anyway. */
  sent?: boolean;
};

export type OfflineAnswer = { status: number; data: unknown };

let idMap: Record<string, string> = {};

export async function loadIdMap(): Promise<void> {
  if (offlineStorageAvailable()) {
    idMap = await getIdMap();
  }
}

export function rememberIdMapping(tempId: string, realId: string): void {
  idMap[tempId] = realId;
}

export function tenantOf(headers: Record<string, string>): string {
  return headers["X-Tenant"] || "default";
}

const TEMP_ID_RE = new RegExp(`${OFFLINE_ID_PREFIX}[0-9a-f-]{36}`, "g");

/** Replaces offline ids that have been synced since with their server ids. */
export function rewriteIds(text: string): string {
  return text.replace(TEMP_ID_RE, id => idMap[id] ?? id);
}

/** True if the text still references an entity that only exists offline. */
export function hasUnsyncedId(text: string): boolean {
  return (text.match(TEMP_ID_RE) ?? []).some(id => !idMap[id]);
}

function pathOf(url: string): { path: string; params: URLSearchParams } {
  const u = new URL(url, "http://local");
  return { path: u.pathname, params: u.searchParams };
}

const REACHABLE_TIMEOUT_MS = 1_500;

export function markOffline(): void {
  offlineState.online = false;
  rememberOnline(false);
}
const REACHABLE_REUSE_MS = 5_000;
let reachableCheck: { at: number; result: Promise<boolean> } | null = null;
const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
let lastProbe = 0;
let probing = false;

export function newTempId(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
  return OFFLINE_ID_PREFIX + uuid;
}

/** Everything the offline queries see: the snapshot plus queued creates, moves and edits. */
async function entities(tenant: string): Promise<{
  all: EntitySummary[];
  pending: PendingEntity[];
  moved: Set<string>;
  patched: Map<string, PendingPatch>;
  fields: Map<string, { name: string; value: string }[]>;
}> {
  const snapshot = await getSnapshot(tenant);
  const pending = await pendingEntities(tenant, snapshot?.summaries ?? []);
  const outbox = (await listOutbox()).filter(e => e.tenant === tenant && !e.error);
  const mapped = (id: string) => idMap[id] ?? id;

  const moves: PendingMove[] = outbox
    .filter((e): e is OutboxMove => e.kind === "move")
    .map(e => ({ entityId: mapped(e.entityId), parentId: mapped(e.parentId) }));
  const patches: PendingPatch[] = outbox
    .filter((e): e is OutboxPatch => e.kind === "patch")
    .map(e => ({ entityId: mapped(e.entityId), quantity: e.body.quantity, tagIds: e.body.tagIds?.map(mapped) }));
  const tags = await localTags(tenant);
  const all = applyPatches(applyMoves([...(snapshot?.summaries ?? []), ...pending], moves), patches, tags);

  // Merged per entity, so a detail page shows the latest queued values.
  const patched = new Map<string, PendingPatch>();
  for (const p of patches) patched.set(p.entityId, { ...patched.get(p.entityId), ...withoutUndefined(p) });
  const fields = new Map<string, { name: string; value: string }[]>();
  for (const e of outbox) {
    if (e.kind !== "field") continue;
    const id = mapped(e.entityId);
    fields.set(id, [...(fields.get(id) ?? []).filter(f => f.name !== e.name), { name: e.name, value: e.value }]);
  }
  return { all, pending, moved: new Set(moves.map(m => m.entityId)), patched, fields };
}

/** Cached tag list plus tags created offline and not synced yet. */
async function localTags(tenant: string): Promise<TagSummary[]> {
  const cached = (await getResponse<TagSummary[]>(tenant, `${API}/tags`)) ?? [];
  const queued = (await listOutbox()).filter(
    (e): e is OutboxTag => e.kind === "tag" && e.tenant === tenant && !e.error && !idMap[e.tempId]
  );
  return [...cached, ...queued.map(tagFromQueue)];
}

function tagFromQueue(e: OutboxTag): TagSummary {
  return {
    id: e.tempId,
    name: e.body.name,
    description: e.body.description ?? "",
    color: e.body.color ?? "",
    icon: e.body.icon ?? "",
    parentId: e.body.parentId ?? null,
    createdAt: e.queuedAt,
    updatedAt: e.queuedAt,
  };
}

function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Queued edits on top of a cached detail answer (GET /entities/{id}). */
function withLocalEdits(
  detail: PendingEntity,
  summary: EntitySummary | undefined,
  patch: PendingPatch | undefined,
  fields: { name: string; value: string }[] | undefined
): PendingEntity {
  let out = detail;
  if (patch) {
    out = { ...out };
    // Not in the snapshot yet (e.g. created after the last sync): the queued value still applies.
    if (patch.quantity !== undefined) out.quantity = summary ? summary.quantity : patch.quantity;
    if (patch.tagIds !== undefined && summary) out.tags = summary.tags;
  }
  if (fields?.length) {
    const current = ((out as { fields?: { name: string }[] }).fields ?? []).filter(
      f => !fields.some(x => x.name === f.name)
    );
    out = {
      ...out,
      fields: [
        ...current,
        ...fields.map(f => ({
          id: "",
          name: f.name,
          type: "text",
          textValue: f.value,
          numberValue: 0,
          booleanValue: false,
        })),
      ],
    } as PendingEntity;
  }
  return out;
}

async function pendingEntities(tenant: string, all: EntitySummary[]): Promise<PendingEntity[]> {
  const outbox = await listOutbox();
  const tags = (await getResponse<TagSummary[]>(tenant, `${API}/tags`)) ?? [];
  const entityTypes = (await getResponse<EntityTypeSummary[]>(tenant, `${API}/entity-types`)) ?? [];
  const known = [...all];
  const result: PendingEntity[] = [];
  for (const entry of outbox) {
    if (entry.kind !== "create" || entry.tenant !== tenant || idMap[entry.tempId]) continue;
    const pending = entityFromCreate(entry.tempId, entry.body as CreateBody, entry.queuedAt, {
      all: known,
      tags,
      entityTypes,
    });
    known.push(pending);
    result.push(pending);
  }
  return result;
}

async function answerGet(req: OfflineRequest): Promise<OfflineAnswer | null> {
  const tenant = tenantOf(req.headers);
  const { path, params } = pathOf(req.url);

  if (path === `${API}/entities`) {
    const { all, moved } = await entities(tenant);
    if (all.length > 0) {
      const details = new Map<string, Partial<PendingEntity>>();
      // Details make search find serial numbers, notes, custom fields...
      if (params.get("q")) {
        const cached = await getEntityDetails<PendingEntity>(tenant);
        for (const e of all) {
          const d = cached.get(e.id);
          // A queued move replaces any location override the cached details carry.
          if (d) details.set(e.id, moved.has(e.id) ? { ...d, locationId: undefined } : d);
        }
      }
      return { status: 200, data: queryEntities(all, params, id => details.get(id)) };
    }
  }

  const assetMatch = path.match(new RegExp(`^${API}/assets/([^/]+)$`));
  if (assetMatch) {
    const { all } = await entities(tenant);
    return { status: 200, data: queryAsset(all, decodeURIComponent(assetMatch[1]!)) };
  }

  const pathMatch = path.match(new RegExp(`^${API}/entities/([^/]+)/path$`));
  if (pathMatch) {
    const { all } = await entities(tenant);
    const p = entityPath(all, pathMatch[1]!);
    if (p) return { status: 200, data: p };
  }

  // /entities/tree, /entities/fields … are endpoints, not entity ids.
  const entityMatch = path.match(new RegExp(`^${API}/entities/([^/]+)$`));
  if (entityMatch && !RESERVED_ENTITY_PATHS.has(entityMatch[1]!)) {
    const id = entityMatch[1]!;
    const { all, pending, moved, patched, fields } = await entities(tenant);
    const summary = all.find(e => e.id === id);
    const edits = (d: PendingEntity) => withLocalEdits(d, summary, patched.get(id), fields.get(id));
    const p = all.find(e => e.id === id && pending.some(x => x.id === id));
    if (p) return { status: 200, data: edits({ ...pending.find(x => x.id === id)!, parent: p.parent }) };
    const cached = await getResponse<PendingEntity>(tenant, path);
    if (cached) {
      if (!moved.has(id)) return { status: 200, data: edits(cached) };
      const parent = summary?.parent ?? cached.parent;
      const location = parent?.entityType?.isLocation ? parent : cached.location;
      return { status: 200, data: edits({ ...cached, parent, location, locationId: undefined }) };
    }
    if (summary) return { status: 200, data: edits(entityFromSummary(summary, all) as PendingEntity) };
    return { status: 404, data: { error: "not available offline" } };
  }

  if (path === `${API}/tags`) {
    return { status: 200, data: await localTags(tenant) };
  }

  const exact = await getResponse(tenant, req.url);
  if (exact !== undefined) {
    return { status: 200, data: exact };
  }
  return null;
}

async function queueCreate(req: OfflineRequest, body: Record<string, unknown>): Promise<OfflineAnswer> {
  const tenant = tenantOf(req.headers);
  const entry: OutboxCreate = {
    kind: "create",
    tempId: newTempId(),
    url: req.url,
    body,
    tenant,
    headers: req.headers,
    queuedAt: new Date().toISOString(),
    attempted: req.sent,
  };
  entry.seq = await addOutbox(entry);
  offlineState.outbox.push(entry);
  offlineState.queuedAt = Date.now();

  const { pending } = await entities(tenant);
  return { status: 201, data: pending.find(p => p.id === entry.tempId) };
}

async function queueAttachment(req: OfflineRequest, entityId: string): Promise<OfflineAnswer | null> {
  const form = req.data!;
  const file = form.get("file");
  if (!(file instanceof Blob)) return null;
  const tenant = tenantOf(req.headers);
  const entry = {
    kind: "attachment" as const,
    entityId,
    file,
    fileName: file instanceof File ? file.name : String(form.get("name") ?? "photo.jpg"),
    name: String(form.get("name") ?? ""),
    type: (form.get("type") as string | null) ?? null,
    primary: (form.get("primary") as string | null) ?? null,
    tenant,
    headers: req.headers,
    queuedAt: new Date().toISOString(),
  };
  const seq = await addOutbox(entry);
  offlineState.outbox.push({ ...entry, seq });
  offlineState.queuedAt = Date.now();

  const answer = await answerGet({ ...req, method: "GET", url: `${API}/entities/${entityId}` });
  return answer && answer.status === 200 ? { status: 201, data: answer.data } : { status: 201, data: {} };
}

/**
 * All entity summaries of a collection as the device knows them (snapshot plus
 * offline changes), for instant local features like the duplicate check.
 */
export async function localEntities(headers: Record<string, string>): Promise<EntitySummary[]> {
  if (!offlineStorageAvailable()) return [];
  return (await entities(tenantOf(headers))).all;
}

/** Only a change of place: { id, parentId[, locationId] }. */
function isMoveBody(body: unknown): body is { parentId: string } {
  if (!body || typeof body !== "object") return false;
  const keys = Object.keys(body as object).filter(k => (body as Record<string, unknown>)[k] !== undefined);
  const b = body as Record<string, unknown>;
  return typeof b.parentId === "string" && keys.every(k => ["id", "parentId", "locationId"].includes(k));
}

/** A quantity and/or tag edit: { id, quantity?, tagIds? }. */
function isPatchBody(body: unknown): body is { id: string; quantity?: number; tagIds?: string[] } {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b).filter(k => b[k] !== undefined && b[k] !== null);
  return (
    keys.some(k => k === "quantity" || k === "tagIds") &&
    keys.every(k => ["id", "quantity", "tagIds"].includes(k)) &&
    (b.quantity === undefined || b.quantity === null || typeof b.quantity === "number") &&
    (b.tagIds === undefined || b.tagIds === null || Array.isArray(b.tagIds))
  );
}

async function queuePatch(req: OfflineRequest, entityId: string): Promise<OfflineAnswer> {
  const tenant = tenantOf(req.headers);
  const { all } = await entities(tenant);
  const b = req.body as { quantity?: number | null; tagIds?: string[] | null };
  const entry: OutboxPatch = {
    kind: "patch",
    entityId,
    url: req.url,
    body: withoutUndefined({ id: entityId, quantity: b.quantity ?? undefined, tagIds: b.tagIds ?? undefined }),
    tenant,
    headers: req.headers,
    queuedAt: new Date().toISOString(),
    entityName: all.find(e => e.id === entityId)?.name ?? "",
  };
  entry.seq = await addOutbox(entry);
  offlineState.outbox.push(entry);
  offlineState.queuedAt = Date.now();

  const answer = await answerGet({ ...req, method: "GET", url: `${API}/entities/${entityId}`, body: undefined });
  return { status: 200, data: answer?.data ?? {} };
}

async function queueTag(req: OfflineRequest): Promise<OfflineAnswer> {
  const tenant = tenantOf(req.headers);
  const entry: OutboxTag = {
    kind: "tag",
    tempId: newTempId(),
    url: req.url,
    body: req.body as OutboxTag["body"],
    tenant,
    headers: req.headers,
    queuedAt: new Date().toISOString(),
    attempted: req.sent,
  };
  entry.seq = await addOutbox(entry);
  offlineState.outbox.push(entry);
  offlineState.queuedAt = Date.now();
  return { status: 201, data: tagFromQueue(entry) };
}

/**
 * Sets a custom text field once the server is reachable (there is no PATCH for
 * fields, so the sync merges it into the current entity). Used by the box check.
 */
export async function queueFieldUpdate(
  headers: Record<string, string>,
  entityId: string,
  name: string,
  value: string
): Promise<void> {
  const tenant = tenantOf(headers);
  const { all } = await entities(tenant);
  const entry: OutboxField = {
    kind: "field",
    entityId,
    name,
    value,
    tenant,
    headers,
    queuedAt: new Date().toISOString(),
    entityName: all.find(e => e.id === entityId)?.name ?? "",
  };
  entry.seq = await addOutbox(entry);
  offlineState.outbox.push(entry);
  offlineState.queuedAt = Date.now();
}

async function queueMove(req: OfflineRequest, entityId: string, parentId: string): Promise<OfflineAnswer> {
  const tenant = tenantOf(req.headers);
  const { all } = await entities(tenant);
  const entry: OutboxMove = {
    kind: "move",
    entityId,
    parentId,
    url: req.url,
    body: req.body as Record<string, unknown>,
    tenant,
    headers: req.headers,
    queuedAt: new Date().toISOString(),
    entityName: all.find(e => e.id === entityId)?.name ?? "",
    targetName: all.find(e => e.id === parentId)?.name ?? "",
  };
  entry.seq = await addOutbox(entry);
  offlineState.outbox.push(entry);
  offlineState.queuedAt = Date.now();

  const answer = await answerGet({ ...req, method: "GET", url: `${API}/entities/${entityId}`, body: undefined });
  return { status: 200, data: answer?.data ?? {} };
}

type WriteKind =
  | { kind: "create" }
  | { kind: "tag" }
  | { kind: "move"; id: string; parentId: string }
  | { kind: "patch"; id: string }
  | { kind: "attachment"; id: string };

/** Which kind of queued write a request becomes offline, if any. */
function writeKind(req: OfflineRequest): WriteKind | null {
  const { path } = pathOf(req.url);
  const isCreate =
    req.method === "POST" &&
    (path === `${API}/entities` || new RegExp(`^${API}/templates/[^/]+/create-item$`).test(path));
  if (isCreate && req.body && typeof req.body === "object") return { kind: "create" };
  if (req.method === "POST" && path === `${API}/tags` && req.body && typeof req.body === "object") {
    return { kind: "tag" };
  }
  const patch = path.match(new RegExp(`^${API}/entities/([^/]+)$`));
  if (req.method === "PATCH" && patch && isMoveBody(req.body)) {
    return { kind: "move", id: patch[1]!, parentId: req.body.parentId };
  }
  if (req.method === "PATCH" && patch && isPatchBody(req.body)) return { kind: "patch", id: patch[1]! };
  const attachment = path.match(new RegExp(`^${API}/entities/([^/]+)/attachments$`));
  if (req.method === "POST" && attachment && req.data) return { kind: "attachment", id: attachment[1]! };
  return null;
}

async function answerWrite(req: OfflineRequest): Promise<OfflineAnswer | null> {
  const w = writeKind(req);
  switch (w?.kind) {
    case "create":
      return queueCreate(req, req.body as Record<string, unknown>);
    case "tag":
      return queueTag(req);
    case "move":
      return queueMove(req, w.id, w.parentId);
    case "patch":
      return queuePatch(req, w.id);
    case "attachment":
      return queueAttachment(req, w.id);
  }
  offlineState.blockedAt = Date.now();
  return null;
}

// --- hooks used by lib/requests ---------------------------------------------

export const offlineHooks = {
  /** Skip the network entirely: known offline, or the request needs ids the server doesn't have yet. */
  skipNetwork(req: OfflineRequest): boolean {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
    // Writes the outbox can hold are queued right away while known offline
    // (sent once back online); anything else (delete, login, ...) still tries.
    if (req.method !== "GET" && offlineState.online === false && writeKind(req)) {
      offlineHooks.probe();
      return true;
    }
    const body = req.body !== undefined ? JSON.stringify(req.body) : "";
    return hasUnsyncedId(req.url) || hasUnsyncedId(body);
  },

  /**
   * A write that may be given up on and queued when the connection is dead:
   * the outbox can hold it and replaying it cannot create a duplicate
   * (creates and tags are checked before replay; uploads are left alone).
   */
  abandonable(req: OfflineRequest): boolean {
    const w = writeKind(req);
    return !!w && w.kind !== "attachment";
  },

  /** The last request did not reach the server. */
  knownOffline(): boolean {
    return offlineState.online === false;
  },

  /**
   * Whether the server answers its tiny status endpoint within
   * REACHABLE_TIMEOUT_MS. One check at a time; the result is reused briefly.
   */
  reachable(maxAgeMs = REACHABLE_REUSE_MS, timeoutMs = REACHABLE_TIMEOUT_MS): Promise<boolean> {
    if (reachableCheck && Date.now() - reachableCheck.at < maxAgeMs) return reachableCheck.result;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    const result = fetch(`${API}/status`, { signal: controller?.signal, cache: "no-store" })
      .then(r => r.ok)
      .catch(() => false)
      .finally(() => clearTimeout(timer));
    reachableCheck = { at: Date.now(), result };
    return result;
  },

  /**
   * Checks the connection now and updates the offline state either way, so a
   * dead connection is noticed before the next tap (phone unlocked in the
   * basement, network switch, regular check while the app is open).
   */
  async checkConnection(): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      markOffline();
      return;
    }
    // Not urgent (nobody waits for it): allow a slow link the probe's time
    // before declaring it dead, so a working mobile connection does not flap.
    if (await offlineHooks.reachable(0, PROBE_TIMEOUT_MS)) offlineState.online = true;
    else markOffline();
  },

  /** Checks in the background (at most every PROBE_INTERVAL_MS) whether the server is back. */
  probe(): void {
    const now = Date.now();
    if (probing || now - lastProbe < PROBE_INTERVAL_MS) return;
    lastProbe = now;
    probing = true;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = setTimeout(() => controller?.abort(), PROBE_TIMEOUT_MS);
    fetch(`${API}/status`, { signal: controller?.signal, cache: "no-store" })
      .then(r => {
        // Back online: the offline plugin syncs queued writes and the copy.
        if (r.ok) offlineState.online = true;
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        probing = false;
      });
  },

  rewrite(req: OfflineRequest): OfflineRequest {
    const body = req.body !== undefined ? JSON.parse(rewriteIds(JSON.stringify(req.body))) : undefined;
    return { ...req, url: rewriteIds(req.url), body };
  },

  async fallback(req: OfflineRequest): Promise<OfflineAnswer | null> {
    if (!offlineStorageAvailable()) return null;
    if (!hasUnsyncedId(req.url)) markOffline();
    try {
      return req.method === "GET" ? await answerGet(req) : await answerWrite(req);
    } catch (e) {
      console.error("[offline] fallback failed", e);
      return null;
    }
  },

  record(req: OfflineRequest, data: unknown): void {
    offlineState.online = true;
    if (!offlineStorageAvailable() || req.method !== "GET" || data === undefined) return;
    putResponse(tenantOf(req.headers), req.url, data).catch(e => console.warn("[offline] cache write failed", e));
  },
};

export type OfflineHooks = typeof offlineHooks;
