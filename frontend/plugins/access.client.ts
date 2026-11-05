/**
 * Fork: Cloudflare Access in front of Homebox (see lib/requests/access.ts).
 *
 * An expired Access session reloads the page only right after the user did
 * something (tap, key, page change) and nothing unsaved is open. Otherwise it
 * shows a hint with a button, so a half-filled form is never thrown away.
 */
import { REAUTH_PARAM, reloadForLogin, setAccessHandlers } from "~/lib/requests/access";
import { toast } from "@/components/ui/sonner";

/** A request this soon after a tap or key press counts as started by the user. */
const USER_ACTION_MS = 3_000;

export default defineNuxtPlugin(nuxtApp => {
  // Back from the Access login: drop the marker that let this load skip the service worker.
  const url = new URL(window.location.href);
  if (url.searchParams.has(REAUTH_PARAM)) {
    url.searchParams.delete(REAUTH_PARAM);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }

  let lastAction = Date.now(); // app start: nothing typed yet
  let dirty = false;
  const acted = () => (lastAction = Date.now());

  window.addEventListener("pointerdown", acted, { capture: true, passive: true });
  window.addEventListener("keydown", acted, { capture: true, passive: true });
  // Any typing means there may be unsaved input until the next page change.
  window.addEventListener("input", () => (dirty = true), { capture: true, passive: true });
  nuxtApp.hook("page:start", () => {
    dirty = false;
    acted();
  });

  setAccessHandlers({
    mayReload: () => Date.now() - lastAction < USER_ACTION_MS && !dirty && !document.querySelector('[role="dialog"]'),
    onExpired: () => {
      const { t } = nuxtApp.$i18nGlobal as { t: (key: string) => string };
      toast.warning(t("offline.access_expired"), {
        id: "access-expired",
        duration: Infinity,
        action: { label: t("offline.access_login"), onClick: () => reloadForLogin() },
      });
    },
  });
});
