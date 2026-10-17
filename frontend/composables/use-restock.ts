import { useI18n } from "vue-i18n";
import { toast } from "@/components/ui/sonner";
import { useTagStore } from "~/stores/tags";

// Fork: shopping list for consumables. An item on the list carries the tag
// "Nachkaufen" — plain Homebox data, so it also shows up in search and filters.

export const RESTOCK_TAG = "Nachkaufen";

export function isRestockTag(tag: { name: string }) {
  return tag.name.trim().toLowerCase() === RESTOCK_TAG.toLowerCase();
}

type Restockable = { id: string; name: string; quantity?: number; tags?: { id: string; name: string }[] };

export function useRestock() {
  const api = useUserApi();
  const { t } = useI18n();
  const tagStore = useTagStore();

  const tag = computed(() => tagStore.tags.find(isRestockTag) ?? null);

  async function ensure(): Promise<string | null> {
    await tagStore.ensureAllTagsFetched();
    if (tag.value) return tag.value.id;
    const { data, error } = await api.tags.create({ name: RESTOCK_TAG, description: "", color: "#f59e0b", icon: "" });
    if (error) return null;
    await tagStore.refresh();
    return data.id;
  }

  const tagIds = (item: Restockable) => (item.tags ?? []).map(tg => tg.id);
  const onList = (item: Restockable) => (item.tags ?? []).some(isRestockTag);

  async function setTags(item: Restockable, ids: string[], extra: { quantity?: number } = {}) {
    const { error } = await api.items.patch(item.id, { id: item.id, tagIds: ids, ...extra });
    if (error) toast.error(t("restock.toast.failed"));
    return !error;
  }

  /** "Aufgebraucht": put the item on the shopping list. */
  async function add(item: Restockable): Promise<boolean> {
    if (onList(item)) return true;
    const id = await ensure();
    if (!id) {
      toast.error(t("restock.toast.failed"));
      return false;
    }
    if (!(await setTags(item, [...tagIds(item), id]))) return false;
    toast.success(t("restock.toast.added", { name: item.name }), {
      action: { label: t("move.undo"), onClick: () => remove(item, true) },
    });
    refreshNuxtData("restock-count");
    return true;
  }

  /** Off the list without buying ("doch nicht"), or as undo. */
  async function remove(item: Restockable, quiet = false): Promise<boolean> {
    const ok = await setTags(
      item,
      (item.tags ?? []).filter(tg => !isRestockTag(tg)).map(tg => tg.id)
    );
    if (ok) {
      refreshNuxtData();
      if (!quiet) toast.info(t("restock.toast.removed", { name: item.name }));
    }
    return ok;
  }

  /** "Gekauft": off the list; an empty stock counts as one again. */
  async function bought(item: Restockable): Promise<boolean> {
    const extra = item.quantity === 0 ? { quantity: 1 } : {};
    const ok = await setTags(
      item,
      (item.tags ?? []).filter(tg => !isRestockTag(tg)).map(tg => tg.id),
      extra
    );
    if (ok) {
      toast.success(t("restock.toast.bought", { name: item.name }), {
        action: {
          label: t("move.undo"),
          onClick: async () => {
            await setTags(item, tagIds(item), item.quantity === 0 ? { quantity: 0 } : {});
            refreshNuxtData();
          },
        },
      });
      refreshNuxtData("restock-count");
    }
    return ok;
  }

  return { tag, onList, add, remove, bought };
}
