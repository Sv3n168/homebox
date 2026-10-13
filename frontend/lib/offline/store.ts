// IndexedDB persistence for offline mode. Kept dependency-free on purpose: a
// handful of object stores with promise wrappers is all we need.
//
//   responses  "<tenant>|<url>" -> last successful JSON body of a GET
//   snapshot   "<tenant>"       -> every entity summary (items + locations)
//   outbox     auto-increment   -> writes made offline, replayed in order
//   meta       key             -> id map (offline id -> server id) etc.

import type { EntitySummary } from "../api/types/data-contracts";

const DB_NAME = "homebox-offline";
const DB_VERSION = 1;

export type CachedResponse = { key: string; data: unknown; savedAt: number };

export type Snapshot = { tenant: string; summaries: EntitySummary[]; savedAt: number };

type OutboxBase = {
  seq?: number;
  tenant: string;
  headers: Record<string, string>;
  queuedAt: string;
  /** A send was started; if it never reported back the server may have it. */
  attempted?: boolean;
  /** Set when the server rejected it — kept so the user can see and discard it. */
  error?: string;
};

export type OutboxCreate = OutboxBase & {
  kind: "create";
  tempId: string;
  url: string;
  body: Record<string, unknown>;
};

export type OutboxAttachment = OutboxBase & {
  kind: "attachment";
  entityId: string;
  file: Blob;
  fileName: string;
  name: string;
  type: string | null;
  primary: string | null;
};

export type OutboxMove = OutboxBase & {
  kind: "move";
  entityId: string;
  parentId: string;
  url: string;
  body: Record<string, unknown>;
  /** For the pending list: "Lichterkette → Kiste 3". */
  entityName: string;
  targetName: string;
};

export type OutboxEntry = OutboxCreate | OutboxAttachment | OutboxMove;

let dbPromise: Promise<IDBDatabase> | null = null;

export function offlineStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("responses", { keyPath: "key" });
        db.createObjectStore("snapshot", { keyPath: "tenant" });
        db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
        db.createObjectStore("meta");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return wrap(fn(db.transaction(store, mode).objectStore(store)));
}

const ENTITY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const responseKey = (tenant: string, url: string) => `${tenant}|${url}`;

export async function getResponse<T = unknown>(tenant: string, url: string): Promise<T | undefined> {
  const row = await tx<CachedResponse | undefined>("responses", "readonly", s => s.get(responseKey(tenant, url)));
  return row?.data as T | undefined;
}

export function putResponse(tenant: string, url: string, data: unknown): Promise<IDBValidKey> {
  return tx("responses", "readwrite", s => s.put({ key: responseKey(tenant, url), data, savedAt: Date.now() }));
}

/** Drops cached detail responses for entities that no longer exist. */
export async function pruneEntityResponses(tenant: string, keepIds: Set<string>): Promise<void> {
  const prefix = responseKey(tenant, "/api/v1/entities/");
  const keys = (await tx<IDBValidKey[]>("responses", "readonly", s => s.getAllKeys())) as string[];
  const stale = keys.filter(k => {
    if (!k.startsWith(prefix)) return false;
    const id = k.slice(prefix.length).split(/[/?]/)[0] ?? "";
    // Only real entity ids; /entities/tree and friends are endpoints.
    return ENTITY_ID_RE.test(id) && !keepIds.has(id);
  });
  for (const k of stale) {
    await tx("responses", "readwrite", s => s.delete(k));
  }
}

export function getSnapshot(tenant: string): Promise<Snapshot | undefined> {
  return tx<Snapshot | undefined>("snapshot", "readonly", s => s.get(tenant));
}

export function putSnapshot(snapshot: Snapshot): Promise<IDBValidKey> {
  return tx("snapshot", "readwrite", s => s.put(snapshot));
}

export function listOutbox(): Promise<OutboxEntry[]> {
  return tx<OutboxEntry[]>("outbox", "readonly", s => s.getAll());
}

export async function addOutbox(entry: OutboxEntry): Promise<number> {
  return (await tx("outbox", "readwrite", s => s.add(entry))) as number;
}

export function putOutbox(entry: OutboxEntry): Promise<IDBValidKey> {
  return tx("outbox", "readwrite", s => s.put(entry));
}

export function deleteOutbox(seq: number): Promise<undefined> {
  return tx("outbox", "readwrite", s => s.delete(seq));
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await tx("meta", "readonly", s => s.get(key))) as T | undefined;
}

export function setMeta(key: string, value: unknown): Promise<IDBValidKey> {
  return tx("meta", "readwrite", s => s.put(value, key));
}

/** Offline id -> server id, for entities created offline and synced since. */
export async function getIdMap(): Promise<Record<string, string>> {
  return (await getMeta<Record<string, string>>("idmap")) ?? {};
}

export async function mapId(tempId: string, realId: string): Promise<void> {
  const map = await getIdMap();
  map[tempId] = realId;
  await setMeta("idmap", map);
}

/** Forget cached inventory data (on logout). Unsynced writes are kept. */
export async function clearCachedData(): Promise<void> {
  await tx("responses", "readwrite", s => s.clear());
  await tx("snapshot", "readwrite", s => s.clear());
}
