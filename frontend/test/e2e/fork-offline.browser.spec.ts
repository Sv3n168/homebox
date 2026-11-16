/**
 * Fork: the basement. After one visit with a connection the app must start
 * cold without one (service worker) and be usable there: browse locations,
 * open a box and its check, change a quantity, move an item, start a new one.
 *
 * fork-features.browser.spec.ts covers the offline logic with the service
 * worker blocked; this is the only place the worker itself is tested.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const EMAIL = "demo@example.com";
const PASSWORD = "demodemo";
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function session(request: APIRequestContext) {
  const login = await request.post("/api/v1/users/login", { data: { username: EMAIL, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { token, attachmentToken } = await login.json();
  const headers = { Authorization: token };
  const types: { id: string; isLocation: boolean }[] = await (
    await request.get("/api/v1/entity-types", { headers })
  ).json();
  const create = async (body: Record<string, unknown>): Promise<{ id: string; name: string }> => {
    const res = await request.post("/api/v1/entities", {
      headers,
      data: { description: "", quantity: 1, tagIds: [], ...body },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return res.json();
  };
  return {
    token: String(token).replace(/^Bearer /, ""),
    attachmentToken: String(attachmentToken ?? ""),
    itemType: types.find(t => !t.isLocation)!.id,
    locationType: types.find(t => t.isLocation)!.id,
    create,
    quantity: async (id: string) =>
      ((await (await request.get(`/api/v1/entities/${id}`, { headers })).json()) as { quantity: number }).quantity,
  };
}

/** Opens the offline status and waits until both the app and the data are on the device. */
async function waitUntilReadyForTheBasement(page: Page) {
  await page.getByTestId("offline-status").filter({ visible: true }).click();
  await expect(page.getByTestId("offline-app-shell")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect(page.getByText(/entr(y|ies) available offline/)).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");
}

test("after one visit the app starts and works without a connection", async ({ page, context, request, baseURL }) => {
  test.setTimeout(240_000);
  const s = await session(request);
  const id = uid();
  const box = await s.create({ name: `Cellar box ${id}`, entityTypeId: s.locationType });
  const other = await s.create({ name: `Other box ${id}`, entityTypeId: s.locationType });
  const jar = await s.create({ name: `Jar ${id}`, entityTypeId: s.itemType, parentId: box.id });

  const url = baseURL ?? "http://localhost:7745";
  await context.addCookies([
    { name: "hb.auth.token", value: s.token, url, httpOnly: true, sameSite: "Lax" },
    { name: "hb.auth.remember", value: "false", url, httpOnly: true, sameSite: "Lax" },
    { name: "hb.auth.session", value: "true", url, sameSite: "Lax" },
    { name: "hb.auth.attachment_token", value: s.attachmentToken, url, sameSite: "Lax" },
  ]);

  // Upstairs: only the start page is opened, nothing else is visited.
  await page.goto("/home");
  await expect(page.getByText("Quick Statistics")).toBeVisible();
  await waitUntilReadyForTheBasement(page);
  await page.close();

  // Basement: no connection, and the app is started from scratch.
  await context.setOffline(true);
  const cellar = await context.newPage();
  const problems: string[] = [];
  cellar.on("pageerror", e => problems.push(e.message));

  await cellar.goto("/home");
  await expect(cellar.getByText("Quick Statistics")).toBeVisible({ timeout: 30_000 });

  // A page that was never opened before, reached inside the app.
  await cellar.getByRole("link", { name: "Locations", exact: true }).first().click();
  await expect(cellar).toHaveURL(/\/locations$/);
  await expect(cellar.getByText(box.name).first()).toBeVisible({ timeout: 30_000 });

  // A box, its content and its check.
  await cellar.goto(`/location/${box.id}`);
  await expect(cellar.getByRole("heading", { name: box.name })).toBeVisible({ timeout: 30_000 });
  await expect(cellar.getByText(jar.name).first()).toBeVisible();
  await cellar.goto(`/location/${box.id}/check`);
  await expect(cellar.getByText(jar.name).first()).toBeVisible({ timeout: 30_000 });

  // Change a quantity and move the item: both are queued.
  await cellar.goto(`/item/${jar.id}`);
  const stepper = cellar.getByTestId("quantity-stepper");
  await expect(stepper).toContainText("1", { timeout: 30_000 });
  await stepper.getByRole("button", { name: "+1" }).click();
  await expect(stepper).toContainText("2");
  await cellar.getByTestId("item-move").click();
  await cellar.getByTestId("box-picker-option").filter({ hasText: other.name }).click();
  await expect(cellar.getByTestId("offline-pending-count").filter({ visible: true })).toHaveText("2");

  // The dialog for a new item opens (its code is loaded on first use).
  await cellar.goto("/home");
  await expect(cellar.getByText("Quick Statistics")).toBeVisible({ timeout: 30_000 });
  await cellar.getByRole("button", { name: "Create", exact: true }).first().click();
  await cellar.getByRole("menuitem", { name: /^Item/ }).first().click();
  await expect(cellar.getByRole("dialog")).toBeVisible();
  await cellar.keyboard.press("Escape");

  expect(problems, problems.join("\n")).toHaveLength(0);
  expect(await s.quantity(jar.id)).toBe(1);

  // Back upstairs: what was queued is sent.
  await context.setOffline(false);
  await cellar.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => s.quantity(jar.id), { timeout: 30_000 }).toBe(2);
});
