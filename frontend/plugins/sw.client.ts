// Fork: register the service worker after the first screen is up, not before.
// Its install precaches every bundle (needed for the offline start in the
// basement); started at the top of <head> that download competed with the
// page's own, which doubled the cold start on a slow connection.
import { toast } from "@/components/ui/sonner";

export default defineNuxtPlugin(nuxtApp => {
  // Fork: parts of the app load on first use (scanner, languages). After an
  // update a page that is still open asks for files of the old version, which
  // are gone. Offer a reload instead of a button that silently does nothing.
  // (Not automatic: a form may be half filled. Page changes are handled by Nuxt.)
  window.addEventListener("vite:preloadError", () => {
    if (navigator.onLine === false) return; // offline: nothing a reload would fix
    const { t } = nuxtApp.$i18nGlobal as { t: (key: string) => string };
    toast.info(t("offline.new_version"), {
      id: "new-version",
      duration: Infinity,
      action: { label: t("offline.new_version_reload"), onClick: () => window.location.reload() },
    });
  });

  if (!("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(e => console.warn("[sw] registration failed", e));
  };
  const idle = () => {
    if ("requestIdleCallback" in window) {
      (
        window as Window & { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => void }
      ).requestIdleCallback(register, { timeout: 10_000 });
    } else {
      setTimeout(register, 3_000);
    }
  };
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
});
