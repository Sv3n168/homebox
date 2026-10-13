import { reactive } from "vue";
import type { OutboxEntry } from "./store";

/** Shared, reactive view of offline mode for the UI. */
export const offlineState = reactive({
  /** Last request reached the server. */
  online: true,
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
