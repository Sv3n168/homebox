<template>
  <section v-if="lentItems.length > 0" data-testid="lent-overview">
    <Subtitle>
      {{ $t("items.lending.overview_title") }}
      <Badge class="ml-2 border-transparent bg-amber-500 text-white">{{ lentItems.length }}</Badge>
      <Badge v-if="overdueCount > 0" variant="destructive" class="ml-1">
        {{ $t("items.lending.overdue_count", { count: overdueCount }) }}
      </Badge>
    </Subtitle>
    <BaseCard>
      <ul class="divide-y">
        <li
          v-for="entry in lentItems"
          :key="entry.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
          :class="{ 'bg-destructive/10': isOverdue(entry) }"
        >
          <MdiHandExtended class="size-5 shrink-0" :class="isOverdue(entry) ? 'text-destructive' : 'text-amber-600'" />
          <div class="min-w-0 grow">
            <NuxtLink :to="`/item/${entry.id}`" class="font-medium hover:underline">{{ entry.name }}</NuxtLink>
            <div class="text-sm text-muted-foreground">
              {{ $t("items.lending.badge_to", { name: entry.lentTo }) }}
              <template v-if="lendingDate(entry.lentDate)">
                · {{ $t("items.lending.since", { date: fmtDate(lendingDate(entry.lentDate)!, "human", "date") }) }}
              </template>
              <template v-if="lendingDate(entry.lentReturnDate)">
                ·
                <span :class="{ 'font-semibold text-destructive': isOverdue(entry) }">
                  {{ $t("items.lending.due", { date: fmtDate(lendingDate(entry.lentReturnDate)!, "human", "date") }) }}
                </span>
              </template>
            </div>
          </div>
          <Button size="sm" variant="outline" @click="returnItem(entry.id)">
            <MdiKeyboardReturn class="mr-1" />
            {{ $t("items.lending.mark_returned") }}
          </Button>
        </li>
      </ul>
    </BaseCard>
  </section>
</template>

<script setup lang="ts">
  import type { EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiHandExtended from "~icons/mdi/hand-extended";
  import MdiKeyboardReturn from "~icons/mdi/keyboard-return";
  import { Badge } from "@/components/ui/badge";
  import { Button } from "@/components/ui/button";
  import BaseCard from "@/components/Base/Card.vue";
  import Subtitle from "~/components/global/Subtitle.vue";
  import { isOverdue, lendingDate } from "~/lib/lending";

  const api = useUserApi();
  const { markReturned } = useLending();

  const { data, refresh } = useAsyncData("lent-items", async () => {
    const { data, error } = await api.items.getAll({ onlyLent: true, page: -1, pageSize: -1 });
    if (error) return [] as EntitySummary[];
    return data.items;
  });

  // Overdue first, then by planned return (no date last), then by name.
  const lentItems = computed(() =>
    [...(data.value ?? [])].sort((a, b) => {
      const od = Number(isOverdue(b)) - Number(isOverdue(a));
      if (od !== 0) return od;
      const da = lendingDate(a.lentReturnDate)?.getTime() ?? Infinity;
      const db = lendingDate(b.lentReturnDate)?.getTime() ?? Infinity;
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name);
    })
  );

  const overdueCount = computed(() => lentItems.value.filter(i => isOverdue(i)).length);

  async function returnItem(id: string) {
    if (await markReturned(id)) {
      refresh();
    }
  }
</script>
