import { useEntityTypeStore } from "~~/stores/entityTypes";

export const INBOX_NAME = "Unsortiert";
const INBOX_RE = /^(unsortiert|inbox|eingang)$/i;

/**
 * The inbox is a plain top-level location called "Unsortiert". New things land
 * there when no box is chosen and get sorted into their real box later.
 */
export function useInbox() {
  const api = useUserApi();
  const locationStore = useLocationStore();
  const entityTypeStore = useEntityTypeStore();

  locationStore.ensureLocationsFetched();

  const inbox = computed(() => {
    const matches = locationStore.allLocations.filter(l => INBOX_RE.test(l.name.trim()));
    return matches.find(l => !l.parent) ?? matches[0] ?? null;
  });

  async function create() {
    await entityTypeStore.ensureFetched();
    const type = entityTypeStore.allTypes.find(t => t.isLocation);
    if (!type) return null;
    const { data, error } = await api.items.createLocation({
      name: INBOX_NAME,
      description: "",
      parentId: null,
      entityTypeId: type.id,
      quantity: 1,
      tagIds: [],
    });
    if (error) return null;
    await locationStore.refreshChildren();
    return data;
  }

  return { inbox, create };
}
