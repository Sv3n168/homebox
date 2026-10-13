<template>
  <!-- Home-screen apps on iOS have no pull-to-refresh; this adds one for the whole page. -->
  <div
    v-if="pull > 0 || refreshing"
    class="pointer-events-none fixed inset-x-0 top-2 z-40 flex justify-center"
    :style="{ transform: `translateY(${Math.min(pull, THRESHOLD)}px)` }"
  >
    <div class="flex size-10 items-center justify-center rounded-full border bg-card shadow-lg">
      <MdiRefresh
        class="size-6 text-primary"
        :class="{ 'animate-spin': refreshing }"
        :style="{
          transform: refreshing ? undefined : `rotate(${pull * 3}deg)`,
          opacity: Math.min(1, pull / THRESHOLD),
        }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
  import MdiRefresh from "~icons/mdi/refresh";

  const THRESHOLD = 70;
  const pull = ref(0);
  const refreshing = ref(false);
  const { $offlineSync } = useNuxtApp();

  let startY: number | null = null;

  function onStart(e: TouchEvent) {
    // Only from the very top, and not while a dialog or sheet is open.
    if (window.scrollY > 0 || refreshing.value || document.querySelector("[role=dialog]")) return;
    startY = e.touches[0]?.clientY ?? null;
  }

  function onMove(e: TouchEvent) {
    if (startY === null) return;
    const dy = (e.touches[0]?.clientY ?? startY) - startY;
    pull.value = dy > 0 && window.scrollY <= 0 ? dy * 0.5 : 0;
  }

  async function onEnd() {
    if (startY === null) return;
    startY = null;
    if (pull.value >= THRESHOLD) {
      refreshing.value = true;
      pull.value = 0;
      try {
        await Promise.all([$offlineSync(true), refreshNuxtData()]);
      } finally {
        refreshing.value = false;
      }
    } else {
      pull.value = 0;
    }
  }

  onMounted(() => {
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
  });
  onUnmounted(() => {
    window.removeEventListener("touchstart", onStart);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("touchend", onEnd);
  });
</script>
