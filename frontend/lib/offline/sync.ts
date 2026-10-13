// Keeps the offline copy fresh and pushes offline writes to the server.
//
// syncAll() = flushOutbox() then downloadSnapshot():
//  1. replay queued creates/photo uploads in order, mapping offline ids to the
//     ids the server hands out
//  2. download every entity summary (items + locations) of the collection
//  3. download details for entities that changed since the last run
//  4. warm the image cache with photo thumbnails
//  5. warm the cache for the few other endpoints the pages need

import type { EntityListResult, EntityOut } from "../api/types/data-contracts";
import { rememberIdMapping } from "./adapter";
import { offlineState } from "./state";
import {
  deleteOutbox,
  getIdMap,
  getResponse,
  getSnapshot,
  listOutbox,
  mapId,
  pruneEntityResponses,
  putOutbox,
  putResponse,
  putSnapshot,
  type OutboxEntry,
} from "./store";

const API = "/api/v1";

/** Must match the runtime cache name in nuxt.config.ts (pwa.workbox). */
export const ATTACHMENT_CACHE = "hb-attachments";

/** Pages fetch these on load; keep a copy so they render offline too. */
const WARM_ENDPOINTS = [
  "/users/self",
  "/users/self/settings",
  "/tags",
  "/entity-types",
  "/templates",
  "/groups",
  "/groups/all",
  "/groups/statistics",
  "/currencies",
  "/entities/tree?withItems=false",
  "/entities/tree?withItems=true",
];

export type SyncContext = {
  tenant: string;
  /** Headers every API call carries (X-Tenant). */
  headers: Record<string, string>;
  attachmentToken: string | null;
};

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function getJSON<T>(ctx: SyncContext, url: string): Promise<T> {
  const r = await fetch(url, { headers: ctx.headers });
  if (!r.ok) throw new HttpError(r.status, `${url}: ${r.status}`);
  return (await r.json()) as T;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
      offlineState.progressDone++;
    }
  });
  await Promise.all(workers);
}

function progress(phase: typeof offlineState.phase, total: number) {
  offlineState.phase = phase;
  offlineState.progressDone = 0;
  offlineState.progressTotal = total;
}

// --- outbox -----------------------------------------------------------------

async function refreshOutboxState() {
  offlineState.outbox = await listOutbox();
}

/**
 * The previous attempt may have reached the server without us hearing back.
 * Look for an entity with the same name and parent created after we queued it.
 */
async function findAlreadyCreated(entry: OutboxEntry & { kind: "create" }, body: Record<string, unknown>) {
  const params = new URLSearchParams({
    q: `"${String(body.name ?? "")}"`,
    orderBy: "createdAt",
    pageSize: "20",
    page: "1",
  });
  params.set("includeArchived", "true");
  const list = await getJSON<EntityListResult>(
    { tenant: entry.tenant, headers: entry.headers, attachmentToken: null },
    `${API}/entities?${params}`
  ).catch(() => null);
  const queued = new Date(entry.queuedAt).getTime() - 60_000;
  return list?.items.find(
    e =>
      e.name === body.name &&
      (e.parent?.id ?? null) === ((body.parentId as string | null) ?? null) &&
      new Date(e.createdAt).getTime() >= queued
  );
}

function withMappedIds<T>(value: T, map: Record<string, string>): T {
  let text = JSON.stringify(value);
  for (const [temp, real] of Object.entries(map)) {
    text = text.split(temp).join(real);
  }
  return JSON.parse(text) as T;
}

type FlushResult = { synced: number; stoppedBy?: "network" | "auth" };

export async function flushOutbox(): Promise<FlushResult> {
  const entries = await listOutbox();
  let synced = 0;
  if (entries.length === 0) return { synced };

  progress("upload", entries.length);
  const failedTempIds = new Set(
    entries.filter(e => e.kind === "create" && e.error).map(e => (e as { tempId: string }).tempId)
  );

  for (const entry of entries) {
    offlineState.progressDone++;
    if (entry.error) continue;
    const map = await getIdMap();

    const fail = async (message: string) => {
      entry.error = message;
      await putOutbox(entry);
      if (entry.kind === "create") failedTempIds.add(entry.tempId);
    };

    try {
      if (entry.kind === "create") {
        const body = withMappedIds(entry.body, map);
        if (failedTempIds.has(String(body.parentId)) || failedTempIds.has(String(body.locationId))) {
          await fail("parent could not be created");
          continue;
        }

        let created: { id: string } | undefined;
        if (entry.attempted) {
          created = await findAlreadyCreated(entry, body);
        }
        if (!created) {
          entry.attempted = true;
          await putOutbox(entry);
          const r = await fetch(withMappedIds(entry.url, map), {
            method: "POST",
            headers: { ...entry.headers, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (r.status === 401) return { synced, stoppedBy: "auth" };
          if (!r.ok) {
            await fail(`${r.status} ${(await r.text()).slice(0, 200)}`);
            continue;
          }
          created = (await r.json()) as EntityOut;
        }
        await mapId(entry.tempId, created.id);
        rememberIdMapping(entry.tempId, created.id);
      } else if (entry.kind === "move") {
        if (failedTempIds.has(entry.entityId) || failedTempIds.has(entry.parentId)) {
          await fail("entity could not be created");
          continue;
        }
        const url = withMappedIds(entry.url, map);
        const body = withMappedIds(entry.body, map);
        if (url.includes("offline-") || JSON.stringify(body).includes("offline-")) {
          // Waits for a create queued after it; try again next round.
          continue;
        }
        // Last write wins: whatever was changed online meanwhile, the place set
        // in the basement is the one that counts.
        const r = await fetch(url, {
          method: "PATCH",
          headers: { ...entry.headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (r.status === 401) return { synced, stoppedBy: "auth" };
        if (!r.ok) {
          await fail(`${r.status} ${(await r.text()).slice(0, 200)}`);
          continue;
        }
      } else {
        const entityId = map[entry.entityId] ?? entry.entityId;
        if (failedTempIds.has(entry.entityId)) {
          await fail("entity could not be created");
          continue;
        }
        if (entityId.startsWith("offline-")) {
          // Its entity hasn't synced yet (queued later?) — try again next round.
          continue;
        }
        const form = new FormData();
        form.append("file", entry.file, entry.fileName);
        if (entry.type) form.append("type", entry.type);
        form.append("name", entry.name);
        if (entry.primary !== null) form.append("primary", entry.primary);
        const r = await fetch(`${API}/entities/${entityId}/attachments`, {
          method: "POST",
          headers: entry.headers,
          body: form,
        });
        if (r.status === 401) return { synced, stoppedBy: "auth" };
        if (!r.ok) {
          await fail(`${r.status} ${(await r.text()).slice(0, 200)}`);
          continue;
        }
      }
      await deleteOutbox(entry.seq!);
      synced++;
    } catch (e) {
      // Network dropped mid-replay; keep the rest for the next round.
      console.warn("[offline] replay interrupted", e);
      return { synced, stoppedBy: "network" };
    } finally {
      await refreshOutboxState();
    }
  }
  return { synced };
}

export async function discardOutboxEntry(seq: number): Promise<void> {
  await deleteOutbox(seq);
  await refreshOutboxState();
}

// --- snapshot ---------------------------------------------------------------

function attachmentURL(ctx: SyncContext, entityId: string, attachmentId: string): string {
  const params = new URLSearchParams();
  if (ctx.attachmentToken) params.set("access_token", ctx.attachmentToken);
  if (ctx.headers["X-Tenant"]) params.set("tenant", ctx.headers["X-Tenant"]);
  const qs = params.toString();
  return `${API}/entities/${entityId}/attachments/${attachmentId}${qs ? `?${qs}` : ""}`;
}

export async function downloadSnapshot(ctx: SyncContext): Promise<void> {
  progress("list", 2);
  const all = `page=-1&pageSize=-1&includeArchived=true`;
  const items = await getJSON<EntityListResult>(ctx, `${API}/entities?${all}`);
  offlineState.progressDone++;
  const locations = await getJSON<EntityListResult>(ctx, `${API}/entities?${all}&isLocation=true`);
  offlineState.progressDone++;
  const summaries = [...items.items, ...locations.items];

  await putSnapshot({ tenant: ctx.tenant, summaries, savedAt: Date.now() });
  offlineState.entityCount = summaries.length;

  for (const path of WARM_ENDPOINTS) {
    const url = API + path;
    const data = await getJSON<unknown>(ctx, url).catch(() => undefined);
    if (data !== undefined) await putResponse(ctx.tenant, url, data);
  }

  // Details for everything that changed since we last fetched it.
  const stale: string[] = [];
  for (const s of summaries) {
    const cached = await getResponse<EntityOut>(ctx.tenant, `${API}/entities/${s.id}`);
    if (!cached || String(cached.updatedAt) !== String(s.updatedAt)) stale.push(s.id);
  }
  progress("details", stale.length);
  await pool(stale, 4, async id => {
    const url = `${API}/entities/${id}`;
    const d = await getJSON<EntityOut>(ctx, url).catch(() => undefined);
    if (d) await putResponse(ctx.tenant, url, d);
  });
  await pruneEntityResponses(ctx.tenant, new Set(summaries.map(s => s.id)));

  await warmImages(
    ctx,
    summaries.map(s => s.id)
  );
  offlineState.lastSnapshotAt = Date.now();
}

/** Photo thumbnails of every entity, so cards and item pages show pictures offline. */
async function warmImages(ctx: SyncContext, ids: string[]): Promise<void> {
  if (typeof caches === "undefined") return;
  const cache = await caches.open(ATTACHMENT_CACHE);

  const wanted: string[] = [];
  for (const id of ids) {
    const d = await getResponse<EntityOut>(ctx.tenant, `${API}/entities/${id}`);
    for (const a of d?.attachments ?? []) {
      if (a.type !== "photo") continue;
      wanted.push(attachmentURL(ctx, id, a.thumbnail?.id ?? a.id));
    }
  }

  const missing: string[] = [];
  for (const url of wanted) {
    if (!(await cache.match(url, { ignoreSearch: true }))) missing.push(url);
  }

  progress("images", missing.length);
  await pool(missing, 4, async url => {
    try {
      const r = await fetch(url);
      if (r.ok) await cache.put(url, r);
    } catch {
      // ignore; retried next sync
    }
  });
}

export async function loadSnapshotInfo(tenant: string): Promise<void> {
  const snapshot = await getSnapshot(tenant);
  offlineState.lastSnapshotAt = snapshot?.savedAt ?? null;
  offlineState.entityCount = snapshot?.summaries.length ?? 0;
  await refreshOutboxState();
}

// --- orchestration ----------------------------------------------------------

let running: Promise<void> | null = null;

/** Replays the outbox, then refreshes the snapshot. Never runs twice at once. */
export function syncAll(ctx: SyncContext, opts: { snapshot: boolean } = { snapshot: true }): Promise<void> {
  if (running) return running;
  running = (async () => {
    offlineState.syncing = true;
    try {
      const flushed = await flushOutbox();
      if (flushed.stoppedBy === "auth") {
        offlineState.needsLogin = true;
        return;
      }
      if (flushed.stoppedBy === "network") {
        offlineState.online = false;
        return;
      }
      offlineState.needsLogin = false;
      offlineState.online = true;
      if (flushed.synced > 0) {
        offlineState.syncedCount = flushed.synced;
        offlineState.syncedAt = Date.now();
      }
      if (opts.snapshot || flushed.synced > 0) {
        await downloadSnapshot(ctx);
      }
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        offlineState.needsLogin = true;
      } else {
        console.warn("[offline] sync failed", e);
        if (!(e instanceof HttpError)) offlineState.online = false;
      }
    } finally {
      offlineState.syncing = false;
      offlineState.phase = "";
      running = null;
    }
  })();
  return running;
}
