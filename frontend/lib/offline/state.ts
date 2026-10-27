import { reactive } from "vue";
import type { OutboxEntry } from "./store";

const OFFLINE_SINCE_KEY = "homebox/offline-at";
/** Opened again within this time after the last failed request: start offline. */
const REMEMBER_OFFLINE_MS = 5 * 60 * 1000;

function offlineRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(OFFLINE_SINCE_KEY));
    return at > 0 && Date.now() - at < REMEMBER_OFFLINE_MS;
  } catch {
    return false;
  }
}

/**
 * Remembers across app starts that the server was just unreachable, so
 * opening the app in the basement does not wait for a request to time out
 * first (the connection is checked in the background instead).
 */
export function rememberOnline(online: boolean): void {
  try {
    if (online) localStorage.removeItem(OFFLINE_SINCE_KEY);
    else localStorage.setItem(OFFLINE_SINCE_KEY, String(Date.now()));
  } catch {
    // storage unavailable: start online, as before
  }
}

/** Shared, reactive view of offline mode for the UI. */
export const offlineState = reactive({
  /** Last request reached the server. */
  online: !offlineRecently(),
  /** A snapshot download or outbox replay is running. */
  syncing: false,
  /** What the running sync is doing, for the progress line. */
  phase: "" as "" | "upload" | "list" | "details" | "images",
  progressDone: 0,
  progressTotal: 0,
  /** When the current collection was last fully downloaded (ms). */
  lastSnapshotAt: null as number | null,
  /** Entities available offline in the current collection. */
  entityCount: 0,
  /** Writes waiting for the server. */
  outbox: [] as OutboxEntry[],
  /** The server answered 401 during replay: user must log in again. */
  needsLogin: false,
  /** Bumped on events the UI turns into toasts. */
  queuedAt: 0,
  blockedAt: 0,
  syncedAt: 0,
  syncedCount: 0,
});

export function pendingCount(): number {
  return offlineState.outbox.filter(e => !e.error).length;
}

export function failedEntries(): OutboxEntry[] {
  return offlineState.outbox.filter(e => !!e.error);
}

/**
 * The offline button is mounted twice (phone and desktop header). Its toast
 * watchers use this shared record so each event shows a single toast.
 */
const shownToasts: Record<string, unknown> = {};
export const offlineToasts = {
  lastQueued: 0,
  once(key: string, value: unknown): boolean {
    if (shownToasts[key] === value) return false;
    shownToasts[key] = value;
    return true;
  },
};
