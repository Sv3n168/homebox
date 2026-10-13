<template>
  <!-- Which frontend this device runs vs. which server it talks to. The PWA can
       keep serving an old cached frontend after an update. -->
  <div class="flex flex-col gap-1 py-6 text-sm" data-testid="version-info">
    <h4 class="mb-1 text-lg font-semibold">{{ $t("version_info.title") }}</h4>
    <div>
      <span class="mr-1 text-muted-foreground">{{ $t("version_info.app") }}:</span>
      <span data-testid="version-app">{{ fmt(appBuildTime) }}</span>
    </div>
    <div v-if="server">
      <span class="mr-1 text-muted-foreground">{{ $t("version_info.server") }}:</span>
      <span data-testid="version-server">{{ server }}</span>
    </div>
    <p v-if="outdated" class="mt-1 text-amber-600 dark:text-amber-400" data-testid="version-outdated">
      {{ $t("version_info.outdated") }}
    </p>
  </div>
</template>

<script setup lang="ts">
  // The server build time is stamped before the image build, the frontend a
  // few minutes later in the same build, so allow some slack.
  const SLACK_MS = 30 * 60 * 1000;

  const appBuildTime = String(useRuntimeConfig().public.appBuildTime ?? "");
  const pubApi = usePublicApi();
  const { data: status } = useAsyncData("version-info-status", async () => (await pubApi.status()).data);

  const time = (v: string) => {
    const t = new Date(v).getTime();
    return isNaN(t) ? null : t;
  };
  const fmt = (v: string) => (time(v) === null ? v || "–" : fmtDate(v, "human", "datetime"));

  const server = computed(() =>
    status.value ? `${status.value.build.version} · ${fmt(status.value.build.buildTime)}` : null
  );

  const outdated = computed(() => {
    const app = time(appBuildTime);
    const server = status.value ? time(status.value.build.buildTime) : null;
    return app !== null && server !== null && server - app > SLACK_MS;
  });
</script>
