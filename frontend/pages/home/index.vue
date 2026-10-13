<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { statCardData } from "./statistics";
  import { itemsTable } from "./table";
  import { useTagStore } from "~/stores/tags";
  import { useLocationStore } from "~~/stores/locations";
  import BaseContainer from "@/components/Base/Container.vue";
  import BaseCard from "@/components/Base/Card.vue";
  import Subtitle from "~/components/global/Subtitle.vue";
  import StatCard from "~/components/global/StatCard/StatCard.vue";
  import ItemCard from "~/components/Item/Card.vue";
  import LocationCard from "~/components/Location/Card.vue";
  import TagChip from "~/components/Tag/Chip.vue";
  import Table from "~/components/Item/View/Table.vue";
  import ItemLentOverview from "~/components/Item/LentOverview.vue";
  import MdiChevronDown from "~icons/mdi/chevron-down";

  const { t } = useI18n();

  definePageMeta({
    middleware: ["auth"],
  });
  useHead({
    title: "HomeBox | " + t("menu.home"),
  });

  const api = useUserApi();
  const breakpoints = useBreakpoints();

  const locationStore = useLocationStore();
  const locations = computed(() => locationStore.parentLocations);

  const tagsStore = useTagStore();
  const tags = computed(() => tagsStore.tags);

  // Remembered per device.
  const statsCollapsed = useLocalStorage("homebox/home/quick-stats-collapsed", false);

  const itemTable = itemsTable(api);
  const stats = statCardData(api);
</script>

<template>
  <div>
    <BaseContainer class="flex flex-col gap-4">
      <section>
        <Subtitle>
          <button
            type="button"
            class="flex items-center gap-1"
            :aria-expanded="!statsCollapsed"
            data-testid="toggle-quick-stats"
            @click="statsCollapsed = !statsCollapsed"
          >
            {{ $t("home.quick_statistics") }}
            <MdiChevronDown class="size-5 transition-transform" :class="{ '-rotate-90': statsCollapsed }" />
          </button>
        </Subtitle>
        <div v-show="!statsCollapsed" class="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-6">
          <StatCard v-for="(stat, i) in stats" :key="i" :title="stat.label" :value="stat.value" :type="stat.type" />
        </div>
      </section>

      <ItemLentOverview />

      <section>
        <Subtitle> {{ $t("home.recently_added") }} </Subtitle>

        <p v-if="itemTable.items.length === 0" class="ml-2 text-sm">{{ $t("items.no_results") }}</p>
        <BaseCard v-else-if="breakpoints.lg">
          <Table :items="itemTable.items" />
        </BaseCard>
        <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ItemCard v-for="item in itemTable.items" :key="item.id" :item="item" />
        </div>
      </section>

      <section>
        <Subtitle> {{ $t("home.storage_locations") }} </Subtitle>
        <p v-if="locations.length === 0" class="ml-2 text-sm">{{ $t("locations.no_results") }}</p>
        <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          <LocationCard v-for="location in locations" :key="location.id" :location="location" />
        </div>
      </section>

      <section>
        <Subtitle> {{ $t("home.tags") }} </Subtitle>
        <p v-if="tags.length === 0" class="ml-2 text-sm">{{ $t("tags.no_results") }}</p>
        <div v-else class="flex flex-wrap gap-4">
          <TagChip v-for="tag in tags" :key="tag.id" size="lg" :tag="tag" class="shadow-md" />
        </div>
      </section>
    </BaseContainer>
  </div>
</template>
