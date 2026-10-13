<template>
  <!-- Phone-only bottom navigation: everything a one-handed user needs. -->
  <nav
    class="app-tabbar fixed inset-x-2 bottom-2 z-30 flex items-end justify-around rounded-[1.6rem] border bg-secondary px-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1 text-secondary-foreground shadow-lg sm:hidden"
    data-testid="tabbar"
  >
    <NuxtLink
      v-for="tab in leftTabs"
      :key="tab.to"
      :to="tab.to"
      :class="[tabClass, tab.active.value ? 'text-primary opacity-100' : 'opacity-75']"
    >
      <component :is="tab.icon" class="size-6" />
      <span>{{ tab.label.value }}</span>
    </NuxtLink>

    <button type="button" :class="[tabClass, '-mt-5 opacity-100']" data-testid="tabbar-scan" @click="$emit('scan')">
      <span
        class="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-4 ring-background"
      >
        <MdiQrcodeScan class="size-7" />
      </span>
      <span>{{ $t("tabbar.scan") }}</span>
    </button>

    <NuxtLink
      v-for="tab in rightTabs"
      :key="tab.to"
      :to="tab.to"
      :class="[tabClass, tab.active.value ? 'text-primary opacity-100' : 'opacity-75']"
    >
      <component :is="tab.icon" class="size-6" />
      <span>{{ tab.label.value }}</span>
    </NuxtLink>

    <button type="button" :class="[tabClass, 'opacity-75']" data-testid="tabbar-create" @click="$emit('create')">
      <MdiPlusCircleOutline class="size-6" />
      <span>{{ $t("tabbar.create") }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import MdiHome from "~icons/mdi/home-outline";
  import MdiMagnify from "~icons/mdi/magnify";
  import MdiQrcodeScan from "~icons/mdi/qrcode-scan";
  import MdiFileTree from "~icons/mdi/file-tree-outline";
  import MdiPlusCircleOutline from "~icons/mdi/plus-circle-outline";

  defineEmits<{ scan: []; create: [] }>();

  const { t } = useI18n();
  const tabClass = "flex flex-1 basis-0 flex-col items-center gap-0.5 py-1 text-[0.68rem] font-medium";
  const route = useRoute();

  const leftTabs = [
    {
      to: "/home",
      icon: MdiHome,
      label: computed(() => t("tabbar.home")),
      active: computed(() => route.path === "/home"),
    },
    {
      to: "/search?focus=1",
      icon: MdiMagnify,
      label: computed(() => t("tabbar.search")),
      active: computed(() => route.path === "/search"),
    },
  ];
  const rightTabs = [
    {
      to: "/locations",
      icon: MdiFileTree,
      label: computed(() => t("tabbar.locations")),
      active: computed(() => route.path.startsWith("/location")),
    },
  ];
</script>
