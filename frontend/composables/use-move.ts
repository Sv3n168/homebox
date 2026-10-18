import { useI18n } from "vue-i18n";
import { toast } from "@/components/ui/sonner";
import { entityToUpdate } from "~/lib/cleanup/duplicates";

export type Movable = {
  id: string;
  name: string;
  parent?: { id: string; name?: string } | null;
  tags?: { id: string; name: string }[];
};
export type MoveTarget = { id: string; name: string };

/**
 * Moves items into a box. Works offline too (queued like new items). Each move
 * offers "Undo", which puts everything back where it was.
 */
export function useMove() {
  const api = useUserApi();
  const { t } = useI18n();
  const places = usePlaces();

  async function setParent(id: string, parentId: string): Promise<boolean> {
    const { error } = await api.items.patch(id, { id, parentId });
    return !error;
  }

  async function move(items: Movable[], target: MoveTarget): Promise<number> {
    const todo = items.filter(i => i.id !== target.id && i.parent?.id !== target.id);
    const previous = todo.map(i => ({
      id: i.id,
      parentId: i.parent?.id ?? null,
      // Only set when the move takes the "Vermisst" tag off.
      tagIds: (i.tags ?? []).some(isMissingTag) ? (i.tags ?? []).map(tg => tg.id) : null,
    }));
    let moved = 0;
    for (const item of todo) {
      if (!(await setParent(item.id, target.id))) continue;
      moved++;
      // Moving something on purpose means it has been found.
      const tags = item.tags ?? [];
      if (tags.some(isMissingTag)) {
        await api.items.patch(item.id, { id: item.id, tagIds: tags.filter(tg => !isMissingTag(tg)).map(tg => tg.id) });
      }
    }
    places.visit(target.id);

    if (moved < todo.length) {
      toast.error(t("move.toast.failed", { count: todo.length - moved }));
    }
    if (moved > 0) {
      const label =
        moved === 1
          ? t("move.toast.moved_one", { name: todo[0]!.name, target: target.name })
          : t("move.toast.moved_many", { count: moved, target: target.name });
      toast.success(label, {
        action: {
          label: t("move.undo"),
          onClick: async () => {
            for (const p of previous) {
              if (p.parentId) {
                await setParent(p.id, p.parentId);
              } else {
                // Was not in any box: a patch cannot clear the parent, an update can.
                const { data } = await api.items.get(p.id);
                if (data) await api.items.update(p.id, { ...entityToUpdate(data), parentId: null });
              }
              if (p.tagIds) await api.items.patch(p.id, { id: p.id, tagIds: p.tagIds });
            }
            toast.info(t("move.toast.undone"));
            refreshNuxtData();
          },
        },
      });
    }
    return moved;
  }

  return { move };
}
