<template>
  <div
    v-if="matches.length > 0"
    class="rounded-xl border border-amber-500/60 bg-amber-500/10 p-3 text-sm"
    data-testid="duplicate-hint"
  >
    <p class="mb-2 font-medium">{{ $t("duplicates.exists") }}</p>
    <div v-for="m in matches" :key="m.id" class="flex items-center gap-2 py-1">
      <div class="min-w-0 grow">
        <NuxtLink :to="`/item/${m.id}`" class="font-medium hover:underline" @click="$emit('navigated')">{{
          m.name
        }}</NuxtLink>
        <span class="text-muted-foreground"> · {{ m.quantity }}× · {{ pathOf(m) }}</span>
      </div>
      <Button type="button" size="sm" variant="outline" data-testid="duplicate-plus-one" @click="plusOne(m)">
        {{ $t("duplicates.plus_one") }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import type { EntitySummary } from "~~/lib/api/types/data-contracts";
  import { Button } from "@/components/ui/button";
  import { toast } from "@/components/ui/sonner";
  import { similarItems } from "~/lib/cleanup/duplicates";

  // Warns while typing a new item's name that it may already exist.

  const props = defineProps<{ name: string }>();
  const emit = defineEmits<{ navigated: []; increased: [id: string] }>();

  const { t } = useI18n();
  const api = useUserApi();
  const loadLocal = useLocalEntities();
  const tree = useFlatLocations();
  const matches = ref<EntitySummary[]>([]);

  watchDebounced(
    () => props.name,
    async name => {
      if (!name || name.trim().length < 3) {
        matches.value = [];
        return;
      }
      let pool = await loadLocal();
      if (pool.length === 0) {
        // No on-device copy yet: ask the server for name matches instead.
        const { data } = await api.items.getAll({ q: name.trim().split(/\s+/)[0], pageSize: 50 });
        pool = data?.items ?? [];
      }
      matches.value = similarItems(name, pool).slice(0, 3);
    },
    { debounce: 300 }
  );

  function pathOf(m: EntitySummary) {
    const id = m.parent?.id;
    const full = (id && tree.value.find(l => l.id === id)?.treeString) || m.parent?.name || "";
    return full.split(" > ").slice(-2).join(" › ");
  }

  async function plusOne(m: EntitySummary) {
    const { error } = await api.items.patch(m.id, { id: m.id, quantity: m.quantity + 1 });
    if (error) {
      toast.error(t("duplicates.toast.plus_one_failed"));
      return;
    }
    toast.success(t("duplicates.toast.plus_one", { name: m.name, count: m.quantity + 1 }));
    emit("increased", m.id);
  }
</script>
