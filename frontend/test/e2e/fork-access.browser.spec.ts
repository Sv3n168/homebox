/**
 * Fork: Cloudflare Access in front of Homebox (lib/requests/access.ts).
 *
 * A small proxy in front of the test server behaves like Access with an expired
 * session: page loads are redirected to a login on another origin, API calls
 * get 401 when they carry X-Requested-With (Cloudflare's documented behaviour),
 * otherwise the same redirect. The app must end on that login or show its
 * "sign in again" hint, and never mistake the situation for being offline.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const EMAIL = "demo@example.com";
const PASSWORD = "demodemo";

type Mode = "valid" | "expired" | "expired-redirect-only";

let mode: Mode = "valid";
let proxy: http.Server;
let accessLogin: http.Server;
let appUrl = "";
let loginUrl = "";

const listen = (server: http.Server) =>
  new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ baseURL }) => {
  const backend = new URL(baseURL ?? "http://localhost:7745");

  accessLogin = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>Access login</title><h1>Cloudflare Access login</h1>");
  });
  loginUrl = `http://127.0.0.1:${await listen(accessLogin)}`;

  proxy = http.createServer((req, res) => {
    if (mode !== "valid") {
      if (mode === "expired" && req.headers["x-requested-with"] === "XMLHttpRequest") {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
        return;
      }
      res.writeHead(302, { Location: `${loginUrl}/cdn-cgi/access/login` });
      res.end();
      return;
    }
    const upstream = http.request(
      { host: backend.hostname, port: backend.port, path: req.url, method: req.method, headers: req.headers },
      answer => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      }
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  // "localhost", not 127.0.0.1: the Access login must be another origin.
  appUrl = `http://localhost:${await listen(proxy)}`;
});

test.afterAll(async () => {
  // Browsers keep connections open; close() alone would wait for them.
  proxy.closeAllConnections();
  accessLogin.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
  await new Promise(resolve => accessLogin.close(resolve));
});

test.beforeEach(() => {
  mode = "valid";
});

/** Logs in through the API and opens the app behind the proxy, service worker in control. */
async function openApp(page: Page, request: APIRequestContext) {
  const res = await request.post("/api/v1/users/login", { data: { username: EMAIL, password: PASSWORD } });
  expect(res.ok()).toBeTruthy();
  const { token, attachmentToken } = await res.json();
  await page.context().addCookies([
    {
      name: "hb.auth.token",
      value: String(token).replace(/^Bearer /, ""),
      url: appUrl,
      httpOnly: true,
      sameSite: "Lax",
    },
    { name: "hb.auth.remember", value: "false", url: appUrl, httpOnly: true, sameSite: "Lax" },
    { name: "hb.auth.session", value: "true", url: appUrl, sameSite: "Lax" },
    { name: "hb.auth.attachment_token", value: attachmentToken ?? "", url: appUrl, sameSite: "Lax" },
  ]);
  await page.goto(`${appUrl}/home`);
  await expect(page).toHaveURL(`${appUrl}/home`);
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 60_000 });
  await page.waitForLoadState("networkidle");
}

const onAccessLogin = (page: Page) => expect(page).toHaveURL(new RegExp(`^${loginUrl}/`), { timeout: 20_000 });
const hint = (page: Page) => page.getByText("Cloudflare sign-in expired");

/** Lets the "the user just did something" window (3 s) pass, then triggers a background check. */
async function backgroundCheck(page: Page) {
  await page.waitForTimeout(3500);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

test.describe("Fork: Cloudflare Access", () => {
  test("without Access in the way the app never reloads or leaves the page by itself", async ({ page, request }) => {
    const seen: string[] = [];
    const at = () => `+${Date.now() - started}ms`;
    let started = Date.now();
    page.on("request", r => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) seen.push(`${at()} document ${r.url()}`);
    });
    page.on("framenavigated", f => {
      if (f === page.mainFrame()) seen.push(`${at()} navigated ${f.url()}`);
    });
    page.on("requestfailed", r => seen.push(`${at()} failed ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
    page.on("pageerror", e => seen.push(`${at()} pageerror ${e.message}`));
    page.on("console", m => {
      if (m.type() === "error" || m.type() === "warning") seen.push(`${at()} console.${m.type()} ${m.text()}`);
    });

    started = Date.now();
    await openApp(page, request);
    // The service worker has taken over and the first sync has run by now.
    await page.waitForTimeout(6000);

    const documents = seen.filter(l => l.includes(" document "));
    expect(documents, seen.join("\n")).toHaveLength(1);
    await expect(page.locator("[data-sonner-toast]"), seen.join("\n")).toHaveCount(0);
  });

  test("a page load with an expired session reaches the Access login, not the cached app", async ({
    page,
    request,
  }) => {
    await openApp(page, request);
    mode = "expired";
    await page.goto(`${appUrl}/home`).catch(() => {});
    await onAccessLogin(page);
  });

  test("opening something reloads to the Access login", async ({ page, request }) => {
    await openApp(page, request);
    mode = "expired";
    await page
      .getByRole("link", { name: /^Locations$/ })
      .first()
      .click();
    await onAccessLogin(page);
  });

  test("the same when Access only redirects (no 401)", async ({ page, request }) => {
    await openApp(page, request);
    mode = "expired-redirect-only";
    await page
      .getByRole("link", { name: /^Locations$/ })
      .first()
      .click();
    await onAccessLogin(page);
  });

  test("in the background: one hint, not offline, and its button signs in again", async ({ page, request }) => {
    await openApp(page, request);
    mode = "expired";
    await backgroundCheck(page);
    await expect(hint(page)).toBeVisible({ timeout: 15_000 });
    await backgroundCheck(page);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
    await expect(page.getByText("Offline", { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(`${appUrl}/home`);

    await page.getByRole("button", { name: "Sign in again" }).click();
    await onAccessLogin(page);
  });

  test("after signing in again the app runs normally", async ({ page, request }) => {
    await openApp(page, request);
    mode = "expired";
    await page.goto(`${appUrl}/home`).catch(() => {});
    await onAccessLogin(page);

    mode = "valid";
    await page.goto(`${appUrl}/home?hb-reauth=1`);
    await expect(page).toHaveURL(`${appUrl}/home`); // marker removed
    await expect(page.getByText("Quick Statistics")).toBeVisible();
    await expect(page.getByText("Offline", { exact: true })).toHaveCount(0);
  });
});
