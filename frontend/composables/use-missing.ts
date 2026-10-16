import { useI18n } from "vue-i18n";
import { toast } from "@/components/ui/sonner";
import { useTagStore } from "~/stores/tags";
import type { Movable } from "./use-move";

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

/**
 * Taking an item off the missing list: "found" (it is where it belongs) or
 * "found in …" (it turned up in another box, so it is moved there).
 */
export function useFound() {
  const api = useUserApi();
  const { t } = useI18n();
  const { pick } = useBoxPicker();
  const { move } = useMove();

  async function found(item: Movable): Promise<boolean> {
    const tagIds = (item.tags ?? []).filter(tg => !isMissingTag(tg)).map(tg => tg.id);
    const { error } = await api.items.patch(item.id, { id: item.id, tagIds });
    if (error) {
      toast.error(t("box_check.toast.found_failed"));
      return false;
    }
    toast.success(t("box_check.toast.found", { name: item.name }));
    return true;
  }

  async function foundIn(item: Movable): Promise<boolean> {
    const box = await pick({
      title: t("box_check.found_in_title", { name: item.name }),
      exclude: item.parent ? [item.parent.id] : [],
    });
    // move() takes the missing tag off as well.
    return !!box && (await move([item], box)) > 0;
  }

  return { found, foundIn };
}
