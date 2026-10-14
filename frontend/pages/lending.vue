<script setup lang="ts">
  // Fork: everything that is lent out, with return / change and "lend something".
  import { useI18n } from "vue-i18n";
  import type { EntityOut, EntitySummary } from "~~/lib/api/types/data-contracts";
  import MdiHandExtended from "~icons/mdi/hand-extended";
  import MdiKeyboardReturn from "~icons/mdi/keyboard-return";
  import MdiPencil from "~icons/mdi/pencil";
  import MdiPlus from "~icons/mdi/plus";
  import { Badge } from "@/components/ui/badge";
  import { Button } from "@/components/ui/button";
  import { Card } from "@/components/ui/card";
  import { Input } from "@/components/ui/input";
  import BaseContainer from "@/components/Base/Container.vue";
  import ItemLendDialog from "~/components/Item/LendDialog.vue";
  import { useDialog } from "@/components/ui/dialog-provider";
  import { DialogID } from "~/components/ui/dialog-provider/utils";
  import { isLent, isOverdue, lendingDate } from "~/lib/lending";

  definePageMeta({ middleware: ["auth"] });

  const { t } = useI18n();
  useHead({ title: "HomeBox | " + t("items.lending.page_title") });

  const api = useUserApi();
  const { markReturned } = useLending();
  const { openDialog } = useDialog();

  const { data, refresh, pending } = useAsyncData("lending-page", async () => {
    const { data, error } = await api.items.getAll({ onlyLent: true, page: -1, pageSize: -1 });
    if (error) return [] as EntitySummary[];
    return data.items;
  });

  // Overdue first, then by planned return (no date last), then by name.
  const lent = computed(() =>
    [...(data.value ?? [])].sort((a, b) => {
      const od = Number(isOverdue(b)) - Number(isOverdue(a));
      if (od !== 0) return od;
      const da = lendingDate(a.lentReturnDate)?.getTime() ?? Infinity;
      const db = lendingDate(b.lentReturnDate)?.getTime() ?? Infinity;
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name);
    })
  );

  const people = computed(() => {
    const counts = new Map<string, number>();
    for (const e of lent.value) counts.set(e.lentTo.trim(), (counts.get(e.lentTo.trim()) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });
  const person = ref<string | null>(null);
  const shown = computed(() => (person.value ? lent.value.filter(e => e.lentTo.trim() === person.value) : lent.value));

  // The dialog reads name and current lending fields, which summaries carry too.
  const target = ref<EntitySummary | null>(null);
  async function edit(e: EntitySummary) {
    target.value = e;
    await nextTick();
    openDialog(DialogID.LendItem);
  }

  async function returnItem(id: string) {
    if (await markReturned(id)) refresh();
  }

  // "Lend something": search items that are not lent out yet.
  const query = ref("");
  const results = ref<EntitySummary[]>([]);
  let searchSeq = 0;
  watchDebounced(
    query,
    async q => {
      const seq = ++searchSeq;
      if (q.trim().length < 2) {
        results.value = [];
        return;
      }
      const { data, error } = await api.items.getAll({ q: q.trim(), pageSize: 20 });
      if (error || seq !== searchSeq) return;
      results.value = data.items.filter(e => !e.entityType?.isLocation && !isLent(e)).slice(0, 8);
    },
    { debounce: 250 }
  );

  function lendNew(e: EntitySummary) {
    query.value = "";
    results.value = [];
    edit(e);
  }

  function saved() {
    target.value = null;
    refresh();
  }
</script>

<template>
  <BaseContainer class="flex flex-col gap-4">
    <header>
      <h1 class="text-2xl font-semibold">{{ $t("items.lending.page_title") }}</h1>
      <p class="text-sm text-muted-foreground">{{ $t("items.lending.page_intro") }}</p>
    </header>

    <ItemLendDialog v-if="target" :item="target as unknown as EntityOut" @saved="saved" />

    <!-- Lend something -->
    <Card class="flex flex-col gap-2 p-3">
      <label class="flex items-center gap-2 font-medium" for="lend-search">
        <MdiPlus class="size-5" />
        {{ $t("items.lending.lend_something") }}
      </label>
      <Input
        id="lend-search"
        v-model="query"
        type="search"
        :placeholder="$t('items.lending.search_item')"
        data-testid="lend-search"
      />
      <ul v-if="results.length > 0" class="divide-y rounded-xl border">
        <li v-for="r in results" :key="r.id">
          <button
            type="button"
            class="flex w-full items-center gap-2 p-2 text-left hover:bg-accent"
            data-testid="lend-search-result"
            @click="lendNew(r)"
          >
            <span class="min-w-0 grow truncate">{{ r.name }}</span>
            <span v-if="r.parent" class="truncate text-sm text-muted-foreground">{{ r.parent.name }}</span>
          </button>
        </li>
      </ul>
      <p v-else-if="query.trim().length >= 2" class="text-sm text-muted-foreground">
        {{ $t("items.lending.no_results") }}
      </p>
    </Card>

    <!-- By person -->
    <div v-if="people.length > 1" class="flex flex-wrap items-center gap-2" data-testid="lending-people">
      <span class="text-sm text-muted-foreground">{{ $t("items.lending.by_person") }}:</span>
      <Button size="sm" :variant="person === null ? 'default' : 'outline'" @click="person = null">
        {{ $t("items.lending.all_people") }}
      </Button>
      <Button
        v-for="[name, count] in people"
        :key="name"
        size="sm"
        :variant="person === name ? 'default' : 'outline'"
        @click="person = person === name ? null : name"
      >
        {{ name }}
        <Badge variant="secondary" class="ml-1">{{ count }}</Badge>
      </Button>
    </div>

    <p v-if="pending && !data" class="text-muted-foreground">{{ $t("global.loading") }}</p>

    <Card
      v-else-if="lent.length === 0"
      class="flex flex-col items-center gap-3 p-8 text-center"
      data-testid="lending-none"
    >
      <MdiHandExtended class="size-12 text-muted-foreground" />
      <p class="text-lg font-medium">{{ $t("items.lending.none") }}</p>
    </Card>

    <Card v-else class="divide-y overflow-hidden">
      <div
        v-for="e in shown"
        :key="e.id"
        class="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 sm:flex-nowrap"
        :class="{ 'bg-destructive/10': isOverdue(e) }"
        data-testid="lending-row"
      >
        <div class="flex min-w-0 basis-full items-start gap-3 sm:grow sm:basis-auto">
          <MdiHandExtended
            class="mt-0.5 size-5 shrink-0"
            :class="isOverdue(e) ? 'text-destructive' : 'text-amber-600'"
          />
          <div class="min-w-0 grow">
            <NuxtLink :to="`/item/${e.id}`" class="font-medium hover:underline">{{ e.name }}</NuxtLink>
            <div class="text-sm text-muted-foreground">
              {{ $t("items.lending.badge_to", { name: e.lentTo }) }}
              <template v-if="lendingDate(e.lentDate)">
                · {{ $t("items.lending.since", { date: fmtDate(lendingDate(e.lentDate)!, "human", "date") }) }}
              </template>
              <template v-if="lendingDate(e.lentReturnDate)">
                ·
                <span :class="{ 'font-semibold text-destructive': isOverdue(e) }">
                  {{ $t("items.lending.due", { date: fmtDate(lendingDate(e.lentReturnDate)!, "human", "date") }) }}
                </span>
              </template>
              <span v-if="isOverdue(e)" class="font-semibold text-destructive">
                · {{ $t("items.lending.overdue") }}</span
              >
            </div>
          </div>
        </div>
        <div class="flex w-full gap-2 sm:w-auto">
          <Button size="sm" variant="outline" class="flex-1 sm:flex-none" data-testid="lending-edit" @click="edit(e)">
            <MdiPencil class="mr-1" />
            {{ $t("items.lending.edit") }}
          </Button>
          <Button size="sm" class="flex-1 sm:flex-none" data-testid="lending-return" @click="returnItem(e.id)">
            <MdiKeyboardReturn class="mr-1" />
            {{ $t("items.lending.mark_returned") }}
          </Button>
        </div>
      </div>
    </Card>
  </BaseContainer>
</template>
