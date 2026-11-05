/**
 * Fork: Cloudflare Access in front of Homebox.
 *
 * When the Access session has expired, Cloudflare answers every request with a
 * 302 to the Access login (another origin). A fetch that follows it fails on
 * CORS, so the app just hangs or (Safari) believes it is offline. Two signals:
 * - `X-Requested-With: XMLHttpRequest` makes Access answer 401 instead of the
 *   redirect (Cloudflare's documented way for single-page apps). Homebox's own
 *   401s are always JSON, so a 401 that is not JSON comes from Access.
 * - `redirect: "manual"` turns a redirect that still happens into an
 *   `opaqueredirect` response.
 *
 * What happens then depends on the request (see AccessMode): only a page load
 * the user started reloads the page, whose navigation follows the redirect and
 * shows the Access login. Anything else must not throw away what is being typed,
 * so it only shows a hint with a button to sign in again.
 *
 * The backend never redirects requests the app makes with fetch (its only
 * redirects are the OIDC login, which is a navigation, and link attachments,
 * which are opened as links, never fetched), so any redirect here means Access.
 */

const RELOAD_KEY = "hb-access-reload-at";

/**
 * Page loads carrying this parameter bypass the service worker (see
 * nuxt.config.ts), so the browser itself follows the redirect to the Access
 * login and can never fall back to the offline copy of the app.
 */
export const REAUTH_PARAM = "hb-reauth";

/** Loads the current page again straight from the network (Access login). */
export function reloadForLogin() {
  const url = new URL(window.location.href);
  url.searchParams.set(REAUTH_PARAM, String(Date.now()));
  window.location.replace(url.toString());
}

/** At most one automatic reload in this time, so a misconfigured Access can't loop the page. */
export const ACCESS_RELOAD_GAP_MS = 30_000;

/**
 * - reload: something the user asked for that only reads (open a page, print a
 *   label). Nothing can be lost, so reload straight away.
 * - notify: saves and background work (sync, connection checks). Show the hint
 *   and fail the request, so open forms keep their input.
 * - silent: telemetry. Drop it, no hint.
 */
export type AccessMode = "reload" | "notify" | "silent";

export class AccessRedirectError extends Error {
  constructor() {
    super("request was redirected (Cloudflare Access session expired?)");
    this.name = "AccessRedirectError";
  }
}

let onExpired: () => void = () => {};
let reloadAllowed: () => boolean = () => true;

/**
 * Set by plugins/access.client.ts: onExpired shows the "sign in again" hint;
 * mayReload says whether a "reload" request may really reload (the user just
 * did something and no unsaved input is open), otherwise it only notifies.
 */
export function setAccessHandlers(handlers: { onExpired: () => void; mayReload: () => boolean }) {
  onExpired = handlers.onExpired;
  reloadAllowed = handlers.mayReload;
}

/**
 * Reloads the page unless that already happened in the last 30 seconds. Only
 * reloads when the time can be stored (sessionStorage), otherwise a loop could
 * not be stopped.
 */
function reloadOnce(): boolean {
  try {
    const now = Date.now();
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (last > 0 && now - last >= 0 && now - last < ACCESS_RELOAD_GAP_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
    reloadForLogin();
    return true;
  } catch {
    return false;
  }
}

/**
 * Handles a redirected response. A reload never settles, so no error toast
 * shows up while the page goes away. Otherwise it throws AccessRedirectError.
 */
export function handleAccessRedirect(mode: AccessMode): Promise<never> {
  if (mode === "reload" && reloadAllowed() && reloadOnce()) return new Promise<never>(() => {});
  if (mode !== "silent") onExpired();
  return Promise.reject(new AccessRedirectError());
}

export function isAccessRedirect(response: Response): boolean {
  if (response.type === "opaqueredirect") return true;
  return response.status === 401 && !response.headers.get("Content-Type")?.startsWith("application/json");
}

/**
 * fetch for same-origin API calls that notices an expired Access session.
 * Never use it for link attachments: those redirect on purpose.
 */
export async function accessFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  mode: AccessMode = "notify"
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Requested-With", "XMLHttpRequest");
  const response = await fetch(input, { credentials: "same-origin", ...init, headers, redirect: "manual" });
  if (isAccessRedirect(response)) return handleAccessRedirect(mode);
  return response;
}
