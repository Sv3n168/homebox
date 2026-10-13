import type { EntityFieldData } from "~~/lib/api/types/data-contracts";
import { entityToUpdate } from "~~/lib/cleanup/duplicates";
import { queueFieldUpdate } from "~~/lib/offline/adapter";
import { offlineState } from "~~/lib/offline/state";

/** Box-check bookkeeping kept as custom text fields on the box itself. */
export const ACK_FIELD = "Prüferinnerung quittiert";
/** sessionStorage key of the home reminder's cached result. */
export const CHECK_REMINDER_CACHE = "homebox/check-reminder";

/**
 * Sets a custom text field on an entity. Without a connection it is queued
 * and merged into the entity once the server is reachable again.
 */
export function useBoxField() {
  const api = useUserApi();
  const prefs = useViewPreferences();
  const isOffline = () => !offlineState.online || (typeof navigator !== "undefined" && navigator.onLine === false);

  async function setField(entityId: string, name: string, value: string): Promise<boolean> {
    if (!isOffline()) {
      const { data, error } = await api.items.getLocation(entityId);
      if (!error && data) {
        const update = entityToUpdate(data);
        const fields = (update.fields ?? []).filter(f => f.name !== name);
        fields.push({
          id: null,
          name,
          type: "text",
          textValue: value,
          numberValue: 0,
          booleanValue: false,
        } as unknown as EntityFieldData);
        const res = await api.items.update(entityId, { ...update, fields });
        if (!res.error) return true;
      }
      if (!isOffline()) return false;
    }
    const tenant = prefs.value.collectionId;
    await queueFieldUpdate(tenant ? { "X-Tenant": tenant } : {}, entityId, name, value);
    return true;
  }

  return { setField };
}

/** Today as YYYY-MM-DD in local time (a check at 00:30 counts for today). */
export function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
