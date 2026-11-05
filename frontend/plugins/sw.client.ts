// Fork: register the service worker after the first screen is up, not before.
// Its install precaches every bundle (needed for the offline start in the
// basement); started at the top of <head> that download competed with the
// page's own, which doubled the cold start on a slow connection.
export default defineNuxtPlugin(() => {
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
