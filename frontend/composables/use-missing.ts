import { useTagStore } from "~/stores/tags";

export const MISSING_TAG = "Vermisst";
export const CHECKED_FIELD = "Zuletzt geprüft";

export function isMissingTag(tag: { name: string }) {
  return tag.name.trim().toLowerCase() === MISSING_TAG.toLowerCase();
}

/** The "Vermisst" tag marks items a box check could not find. */
export function useMissingTag() {
  const api = useUserApi();
  const tagStore = useTagStore();

  const tag = computed(() => tagStore.tags.find(isMissingTag) ?? null);

  async function ensure(): Promise<string | null> {
    await tagStore.ensureAllTagsFetched();
    if (tag.value) return tag.value.id;
    const { data, error } = await api.tags.create({ name: MISSING_TAG, description: "", color: "#ef4444", icon: "" });
    if (error) return null;
    await tagStore.refresh();
    return data.id;
  }

  return { tag, ensure };
}
