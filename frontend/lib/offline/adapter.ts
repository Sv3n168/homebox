// The bridge between lib/requests and offline mode. Requests calls into this
// for every API call made through useUserApi():
//
//  - successful JSON GETs are remembered (IndexedDB "responses")
//  - when the server can't be reached, GETs are answered locally: entity
//    lists/search/asset lookups from the snapshot, everything else from the
//    remembered responses
//  - creating entities and uploading their photos is queued in the outbox and
//    answered with a pending entity, so the create dialog just works offline
//  - every other write is refused with a clear offline error

import type { EntitySummary, EntityTypeSummary, TagSummary } from "../api/types/data-contracts";
import {
  applyMoves,
  entityFromCreate,
  entityFromSummary,
  entityPath,
  queryAsset,
  queryEntities,
  type CreateBody,
  type PendingEntity,
  type PendingMove,
} from "./query";
import {
  addOutbox,
  getIdMap,
  getResponse,
  getSnapshot,
  listOutbox,
  offlineStorageAvailable,
  putResponse,
  type OutboxCreate,
  type OutboxMove,
} from "./store";
import { offlineState } from "./state";

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

/** Everything the offline queries see: the snapshot plus queued creates and moves. */
async function entities(
  tenant: string
): Promise<{ all: EntitySummary[]; pending: PendingEntity[]; moved: Set<string> }> {
  const snapshot = await getSnapshot(tenant);
  const pending = await pendingEntities(tenant, snapshot?.summaries ?? []);
  const moves = await pendingMoves(tenant);
  const all = applyMoves([...(snapshot?.summaries ?? []), ...pending], moves);
  return { all, pending, moved: new Set(moves.map(m => m.entityId)) };
}

async function pendingMoves(tenant: string): Promise<PendingMove[]> {
  const outbox = await listOutbox();
  return outbox
    .filter((e): e is OutboxMove => e.kind === "move" && e.tenant === tenant && !e.error)
    .map(e => ({ entityId: idMap[e.entityId] ?? e.entityId, parentId: idMap[e.parentId] ?? e.parentId }));
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
        for (const e of all) {
          const d = await getResponse<PendingEntity>(tenant, `${API}/entities/${e.id}`);
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
    const { all, pending, moved } = await entities(tenant);
    const p = all.find(e => e.id === id && pending.some(x => x.id === id));
    if (p) return { status: 200, data: { ...pending.find(x => x.id === id), parent: p.parent } };
    const cached = await getResponse<PendingEntity>(tenant, path);
    if (cached) {
      if (!moved.has(id)) return { status: 200, data: cached };
      const parent = all.find(e => e.id === id)?.parent ?? cached.parent;
      const location = parent?.entityType?.isLocation ? parent : cached.location;
      return { status: 200, data: { ...cached, parent, location, locationId: undefined } };
    }
    const summary = all.find(e => e.id === id);
    if (summary) return { status: 200, data: entityFromSummary(summary, all) };
    return { status: 404, data: { error: "not available offline" } };
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

async function answerWrite(req: OfflineRequest): Promise<OfflineAnswer | null> {
  const { path } = pathOf(req.url);
  const isCreate =
    req.method === "POST" &&
    (path === `${API}/entities` || new RegExp(`^${API}/templates/[^/]+/create-item$`).test(path));

  if (isCreate && req.body && typeof req.body === "object") {
    return queueCreate(req, req.body as Record<string, unknown>);
  }

  const patch = path.match(new RegExp(`^${API}/entities/([^/]+)$`));
  if (req.method === "PATCH" && patch && isMoveBody(req.body)) {
    return queueMove(req, patch[1]!, req.body.parentId);
  }

  const attachment = path.match(new RegExp(`^${API}/entities/([^/]+)/attachments$`));
  if (req.method === "POST" && attachment && req.data) {
    return queueAttachment(req, attachment[1]!);
  }

  offlineState.blockedAt = Date.now();
  return null;
}

// --- hooks used by lib/requests ---------------------------------------------

export const offlineHooks = {
  /** Skip the network entirely: known offline, or the request needs ids the server doesn't have yet. */
  skipNetwork(req: OfflineRequest): boolean {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
    const body = req.body !== undefined ? JSON.stringify(req.body) : "";
    return hasUnsyncedId(req.url) || hasUnsyncedId(body);
  },

  rewrite(req: OfflineRequest): OfflineRequest {
    const body = req.body !== undefined ? JSON.parse(rewriteIds(JSON.stringify(req.body))) : undefined;
    return { ...req, url: rewriteIds(req.url), body };
  },

  async fallback(req: OfflineRequest): Promise<OfflineAnswer | null> {
    if (!offlineStorageAvailable()) return null;
    if (!hasUnsyncedId(req.url)) {
      offlineState.online = false;
    }
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
