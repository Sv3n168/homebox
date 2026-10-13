import { watch } from "vue";
import { loadIdMap, OFFLINE_ID_PREFIX } from "~~/lib/offline/adapter";
import { offlineState } from "~~/lib/offline/state";
import { offlineStorageAvailable, getIdMap } from "~~/lib/offline/store";
import { loadSnapshotInfo, syncAll, type SyncContext } from "~~/lib/offline/sync";

/** A full download at most this often; outbox replays happen on every trigger. */
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2 * 60 * 1000;

export default defineNuxtPlugin(nuxtApp => {
  if (!offlineStorageAvailable()) {
    const noop = (force?: boolean) => Promise.resolve(void force);
    return { provide: { offlineSync: noop } };
  }

  // Ask the browser not to evict the offline copy under storage pressure.
  navigator.storage?.persist?.().catch(() => {});

  const prefs = useViewPreferences();
  const auth = useAuthContext();
  const router = useRouter();

  const context = (): SyncContext => {
    const collectionId = prefs.value.collectionId;
    return {
      tenant: collectionId || "default",
      headers: collectionId ? { "X-Tenant": collectionId } : {},
      attachmentToken: auth.attachmentToken,
    };
  };

  let lastSnapshot = 0;
  const sync = async (force = false) => {
    if (!auth.isAuthorized()) return;
    const snapshot = force || Date.now() - lastSnapshot > SNAPSHOT_INTERVAL_MS;
    if (snapshot) lastSnapshot = Date.now();
    await syncAll(context(), { snapshot });
  };

  nuxtApp.hook("app:mounted", async () => {
    await loadIdMap();
    await loadSnapshotInfo(context().tenant);
    // Let the first page load finish before downloading everything.
    setTimeout(() => sync(), 1500);
  });

  window.addEventListener("online", () => sync(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
  });
  setInterval(() => {
    if (offlineState.outbox.length > 0 || !offlineState.online) sync();
  }, POLL_INTERVAL_MS);

  // A page request got through again: push what was queued meanwhile.
  watch(
    () => offlineState.online,
    (now, before) => {
      if (now && !before) sync(true);
    }
  );

  watch(
    () => prefs.value.collectionId,
    async () => {
      await loadSnapshotInfo(context().tenant);
      sync(true);
    }
  );

  // Created offline and synced since: move the open page to the real id.
  watch(
    () => offlineState.syncedAt,
    async () => {
      const path = router.currentRoute.value.fullPath;
      if (!path.includes(OFFLINE_ID_PREFIX)) return;
      const map = await getIdMap();
      const next = path.replace(new RegExp(`${OFFLINE_ID_PREFIX}[0-9a-f-]{36}`, "g"), id => map[id] ?? id);
      if (next !== path) router.replace(next);
    }
  );

  return { provide: { offlineSync: sync } };
});
