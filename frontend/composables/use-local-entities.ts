import { localEntities } from "~~/lib/offline/adapter";
import type { EntitySummary } from "~~/lib/api/types/data-contracts";

/** Every item of the current collection from the on-device copy (no network). */
export function useLocalEntities() {
  const prefs = useViewPreferences();
  return async (): Promise<EntitySummary[]> => {
    const id = prefs.value.collectionId;
    const all = await localEntities(id ? { "X-Tenant": id } : {});
    return all.filter(e => !e.entityType?.isLocation && !e.archived);
  };
}
