<template>
  <!-- Status and schedule of the encrypted OneDrive backup (deploy/backup sidecar). -->
  <div class="flex flex-col gap-3 py-6" data-testid="offsite-backup">
    <h4 class="text-lg font-semibold">{{ $t("offsite_backup.title") }}</h4>

    <p v-if="!status" class="text-sm text-muted-foreground">{{ $t("global.loading") }}</p>
    <p v-else-if="!status.configured" class="text-sm text-muted-foreground" data-testid="offsite-backup-none">
      {{ $t("offsite_backup.not_configured") }}
    </p>

    <template v-else>
      <div
        v-for="row in rows"
        :key="row.key"
        class="flex items-start gap-2 text-sm"
        :data-testid="`offsite-backup-${row.key}`"
        :data-state="row.tone"
      >
        <component :is="row.icon" class="mt-0.5 size-5 shrink-0" :class="toneClass[row.tone]" />
        <div>
          <div class="font-medium">{{ row.title }}</div>
          <div class="text-muted-foreground">{{ row.text }}</div>
        </div>
      </div>

      <form class="mt-2 flex flex-wrap items-end gap-3" @submit.prevent="save">
        <label class="flex flex-col gap-1 text-sm">
          {{ $t("offsite_backup.interval") }}
          <select
            v-model.number="form.intervalDays"
            class="rounded-md border bg-background px-2 py-1.5"
            data-testid="offsite-backup-interval"
          >
            <option v-for="d in [1, 2, 3, 7]" :key="d" :value="d">
              {{ $t("offsite_backup.every_days", { n: d }) }}
            </option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          {{ $t("offsite_backup.keep") }}
          <select
            v-model.number="form.keepMonths"
            class="rounded-md border bg-background px-2 py-1.5"
            data-testid="offsite-backup-keep"
          >
            <option v-for="m in [1, 2, 3, 6, 12, 24]" :key="m" :value="m">
              {{ $t("offsite_backup.months", { n: m }) }}
            </option>
          </select>
        </label>
        <Button type="submit" size="sm" :disabled="saving || !dirty" data-testid="offsite-backup-save">
          {{ $t("global.save") }}
        </Button>
      </form>
      <p class="text-xs text-muted-foreground">{{ $t("offsite_backup.settings_hint") }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { toast } from "@/components/ui/sonner";
  import { route } from "~~/lib/api/base";
  import MdiCheckCircle from "~icons/mdi/check-circle";
  import MdiAlertCircle from "~icons/mdi/alert-circle";
  import MdiClockOutline from "~icons/mdi/clock-outline";
  import { Button } from "@/components/ui/button";

  type Run = { state: string; at: number; detail: string } | null;
  type Settings = { intervalDays: number; keepMonths: number };
  type Status = {
    configured: boolean;
    maxAgeHours: number;
    startedAt: number;
    backup: Run;
    verify: Run;
    settings: Settings;
  };
  type Tone = "ok" | "warn" | "fail" | "idle";

  const { t } = useI18n();
  const api = useUserApi();

  const status = ref<Status | null>(null);
  const form = reactive<Settings>({ intervalDays: 1, keepMonths: 2 });
  const saving = ref(false);
  const dirty = computed(
    () =>
      !!status.value &&
      (form.intervalDays !== status.value.settings.intervalDays || form.keepMonths !== status.value.settings.keepMonths)
  );

  const toneClass: Record<Tone, string> = {
    ok: "text-green-600",
    warn: "text-amber-500",
    fail: "text-destructive",
    idle: "text-muted-foreground",
  };
  const toneIcon: Record<Tone, unknown> = {
    ok: MdiCheckCircle,
    warn: MdiAlertCircle,
    fail: MdiAlertCircle,
    idle: MdiClockOutline,
  };

  const when = (at: number) => fmtDate(at * 1000, "relative", "date");

  const rows = computed(() => {
    const s = status.value;
    if (!s?.configured) return [];
    const now = Date.now() / 1000;
    const maxAge = s.maxAgeHours * 3600;

    let backup: { tone: Tone; text: string };
    if (!s.backup) {
      backup =
        s.startedAt && now - s.startedAt > maxAge
          ? { tone: "warn", text: t("offsite_backup.backup_never_overdue") }
          : { tone: "idle", text: t("offsite_backup.backup_never") };
    } else if (s.backup.state !== "ok") {
      backup = {
        tone: "fail",
        text: t("offsite_backup.backup_failed", { when: when(s.backup.at), detail: s.backup.detail }),
      };
    } else if (now - s.backup.at > maxAge) {
      backup = { tone: "warn", text: t("offsite_backup.backup_stale", { when: when(s.backup.at) }) };
    } else {
      backup = { tone: "ok", text: t("offsite_backup.backup_ok", { when: when(s.backup.at) }) };
    }

    let verify: { tone: Tone; text: string };
    if (!s.verify) {
      verify = { tone: "idle", text: t("offsite_backup.verify_never") };
    } else if (s.verify.state !== "ok") {
      verify = {
        tone: "fail",
        text: t("offsite_backup.verify_failed", { when: when(s.verify.at), detail: s.verify.detail }),
      };
    } else {
      verify = {
        tone: "ok",
        text: t("offsite_backup.verify_ok", { when: when(s.verify.at), detail: s.verify.detail }),
      };
    }

    return [
      { key: "backup", title: t("offsite_backup.backup"), icon: toneIcon[backup.tone], ...backup },
      { key: "verify", title: t("offsite_backup.verify"), icon: toneIcon[verify.tone], ...verify },
    ];
  });

  async function load() {
    const { data, error } = await api.http.get<Status>({ url: route("/offsite-backup/status") });
    if (error) return;
    status.value = data;
    Object.assign(form, data.settings);
  }

  async function save() {
    saving.value = true;
    const { data, error } = await api.http.put<Settings, Settings>({
      url: route("/offsite-backup/settings"),
      body: { ...form },
    });
    saving.value = false;
    if (error) {
      toast.error(t("offsite_backup.toast.save_failed"));
      return;
    }
    if (status.value) status.value.settings = data;
    toast.success(t("offsite_backup.toast.saved"));
  }

  onMounted(load);
</script>
