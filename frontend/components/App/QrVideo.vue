<template>
  <div class="relative overflow-hidden rounded-2xl bg-black">
    <video ref="video" class="h-72 w-full object-cover" muted playsinline />
    <div class="pointer-events-none absolute inset-8 rounded-2xl border-2 border-white/70" />
    <p v-if="error" class="absolute inset-x-0 bottom-0 bg-black/70 p-2 text-center text-sm text-white">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { BrowserMultiFormatReader } from "@zxing/library";

  // Minimal live QR reader (back camera) used inside dialogs.

  const emit = defineEmits<{ result: [text: string] }>();
  const { t } = useI18n();
  const video = ref<HTMLVideoElement>();
  const error = ref("");
  const reader = new BrowserMultiFormatReader();

  onMounted(async () => {
    try {
      await reader.decodeFromConstraints({ video: { facingMode: { ideal: "environment" } } }, video.value!, result => {
        if (result) {
          navigator.vibrate?.(40);
          emit("result", result.getText());
        }
      });
    } catch (e) {
      console.error(e);
      error.value = t("scanner.permission_denied");
    }
  });

  onUnmounted(() => reader.reset());
</script>
