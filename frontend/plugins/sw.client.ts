// Fork: register the service worker after the first screen is up, not before.
// Its install precaches every bundle (needed for the offline start in the
// basement); started at the top of <head> that download competed with the
// page's own, which doubled the cold start on a slow connection.
import { toast } from "@/components/ui/sonner";
import { offlineState } from "~~/lib/offline/state";

/** A failed install (one file did not arrive) is tried again this often, this far apart. */
const RETRIES = 6;
const RETRY_MS = 20_000;

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

  if (!("serviceWorker" in navigator)) {
    // Browsers only offer service workers (and the cache they need) on a secure
    // address: https://, or localhost. Over http:// on a home network address the
    // app can never start offline; say so instead of a generic "not supported".
    offlineState.appShell = window.isSecureContext ? "unsupported" : "insecure";
    return { provide: { prepareOfflineStart: () => {} } };
  }
  const sw = navigator.serviceWorker;

  // The cloud icon only shows "ready" once the app can really start offline:
  // a worker that controls this page has stored every file.
  let retries = 0;
  let counter: ReturnType<typeof setInterval> | undefined;
  const countFiles = async () => {
    try {
      let n = 0;
      for (const name of await caches.keys()) {
        if (name.includes("precache")) n += (await (await caches.open(name)).keys()).length;
      }
      offlineState.appShellFiles = n;
    } catch {
      // Cache storage not available: the count is only for display.
    }
  };
  const setState = (state: typeof offlineState.appShell) => {
    offlineState.appShell = state;
    if (state === "preparing" && !counter) counter = setInterval(countFiles, 2_000);
    if (state !== "preparing" && counter) {
      clearInterval(counter);
      counter = undefined;
    }
    countFiles();
  };
  const refresh = () => {
    if (sw.controller) setState("ready");
    else if (offlineState.appShell !== "failed") setState("preparing");
  };

  const watch = (reg: ServiceWorkerRegistration) => {
    const follow = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        // "redundant" before it ever became active: the install failed, usually
        // because one file did not arrive. What was stored so far is kept, so
        // another try continues instead of starting over.
        if (worker.state === "redundant" && !sw.controller) {
          // The browser gives no reason here; a file that did not arrive is the usual one.
          offlineState.appShellError = "";
          setState("failed");
          if (retries++ < RETRIES) setTimeout(register, RETRY_MS);
        } else {
          refresh();
        }
      });
    };
    follow(reg.installing);
    reg.addEventListener("updatefound", () => {
      follow(reg.installing);
      refresh();
    });
    refresh();
  };

  let watched: ServiceWorkerRegistration | undefined;
  function register() {
    sw.register("/sw.js", { scope: "/" })
      .then(reg => {
        if (watched !== reg) {
          watched = reg;
          watch(reg);
        } else {
          // Same registration: ask the browser to try the install again.
          if (!sw.controller) setState("preparing");
          reg.update().catch(() => {});
        }
      })
      .catch(e => {
        console.warn("[sw] registration failed", e);
        // E.g. a certificate the device does not trust: the page still opens
        // after "continue anyway", but the browser refuses the service worker.
        offlineState.appShellError = `${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? String(e)}`;
        if (!sw.controller) setState("failed");
        if (retries++ < RETRIES) setTimeout(register, RETRY_MS);
      });
  }
  sw.addEventListener("controllerchange", refresh);
  refresh();

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

  return {
    provide: {
      /** "Try again" in the offline status: restarts the preparation by hand. */
      prepareOfflineStart: () => {
        retries = 0;
        register();
      },
    },
  };
});
