// Fork only: end-to-end checks for the features this fork adds on top of
// Homebox (lending, box check, bulk move, places with sub-locations, offline
// edits, logo). They run with the upstream suite on every PR, including the
// "Update vom Original" PRs, so an upstream change that breaks one shows up
// before it reaches the server. Each test creates its own data via the API.
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const EMAIL = "demo@example.com";
const PASSWORD = "demodemo";

type Entity = { quantity: number; lentTo?: string; tags?: unknown[]; parent?: { id: string } | null };
type Api = {
  create: (body: Record<string, unknown>) => Promise<{ id: string; name: string }>;
  get: (id: string) => Promise<Entity>;
  itemType: string;
  locationType: string;
};

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function api(request: APIRequestContext): Promise<Api> {
  const login = await request.post("/api/v1/users/login", { data: { username: EMAIL, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();
  const headers = { Authorization: token };

  const types: { id: string; isLocation: boolean }[] = await (
    await request.get("/api/v1/entity-types", { headers })
  ).json();
  const itemType = types.find(t => !t.isLocation)!.id;
  const locationType = types.find(t => t.isLocation)!.id;

  return {
    itemType,
    locationType,
    async create(body) {
      const res = await request.post("/api/v1/entities", {
        headers,
        data: { description: "", quantity: 1, tagIds: [], ...body },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      return res.json();
    },
    async get(id) {
      const res = await request.get(`/api/v1/entities/${id}`, { headers });
      expect(res.ok()).toBeTruthy();
      return res.json();
    },
  };
}

async function login(page: Page) {
  await page.goto("/home");
  await expect(page).toHaveURL("/");
  await page.fill("input[type='text']", EMAIL);
  await page.fill("input[type='password']", PASSWORD);
  await page.click("button[type='submit']");
  await expect(page).toHaveURL("/home");
}

test.describe("Fork features", () => {
  test("shows the custom logo", async ({ page }) => {
    await page.goto("/");
    const logo = page.locator("img[src='/logo.png']").first();
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  });

  test("lends an item and marks it returned", async ({ page, request }) => {
    const a = await api(request);
    const item = await a.create({ name: `Lend ${uid()}`, entityTypeId: a.itemType });

    await login(page);
    await page.goto(`/item/${item.id}`);
    await page.getByRole("button", { name: "Lend", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("input").first().fill("Anna");
    await dialog.getByRole("button", { name: "Lend", exact: true }).click();

    await expect(page.getByTestId("lent-banner")).toContainText("Lent to Anna");
    expect((await a.get(item.id)).lentTo).toBe("Anna");

    await page.getByTestId("lent-return").click();
    await expect(page.getByTestId("lent-banner")).toHaveCount(0);
    await expect.poll(async () => (await a.get(item.id)).lentTo ?? "").toBe("");
  });

  test("checks a box and flags a missing item", async ({ page, request }) => {
    const a = await api(request);
    const id = uid();
    const box = await a.create({ name: `Check ${id}`, entityTypeId: a.locationType });
    await a.create({ name: `Here ${id}`, entityTypeId: a.itemType, parentId: box.id });
    const gone = await a.create({ name: `Gone ${id}`, entityTypeId: a.itemType, parentId: box.id });

    await login(page);
    await page.goto(`/location/${box.id}/check`);
    const rows = page.getByTestId("box-check-row");
    await expect(rows).toHaveCount(2);
    await rows
      .filter({ hasText: `Here ${id}` })
      .getByTestId("box-check-present")
      .click();
    await rows
      .filter({ hasText: `Gone ${id}` })
      .getByTestId("box-check-missing")
      .click();
    await page.getByTestId("box-check-finish").click();

    await expect(page.getByTestId("box-check-done")).toContainText("1 missing");
    await expect.poll(async () => ((await a.get(gone.id)).tags ?? []).length).toBe(1);
  });

  test("moves several items into another box at once", async ({ page, request }) => {
    const a = await api(request);
    const id = uid();
    const from = await a.create({ name: `From ${id}`, entityTypeId: a.locationType });
    const to = await a.create({ name: `Target ${id}`, entityTypeId: a.locationType });
    const one = await a.create({ name: `One ${id}`, entityTypeId: a.itemType, parentId: from.id });
    const two = await a.create({ name: `Two ${id}`, entityTypeId: a.itemType, parentId: from.id });

    await login(page);
    await page.goto(`/location/${from.id}`);
    await page.getByRole("checkbox", { name: "Select All" }).click();
    await expect(page.getByTestId("selection-bar")).toContainText("2");
    await page.getByTestId("selection-move").click();
    await page.getByTestId("box-picker-search").fill(`Target ${id}`);
    await page
      .getByTestId("box-picker-option")
      .filter({ hasText: `Target ${id}` })
      .click();

    await expect.poll(async () => (await a.get(one.id)).parent?.id).toBe(to.id);
    await expect.poll(async () => (await a.get(two.id)).parent?.id).toBe(to.id);
  });

  test("places with sub-locations list them first and fold their own items", async ({ page, request }) => {
    const a = await api(request);
    const id = uid();
    const place = await a.create({ name: `Cellar ${id}`, entityTypeId: a.locationType });
    await a.create({ name: `Shelf ${id}`, entityTypeId: a.locationType, parentId: place.id });
    await a.create({ name: `Ladder ${id}`, entityTypeId: a.itemType, parentId: place.id });
    const flat = await a.create({ name: `Flat ${id}`, entityTypeId: a.locationType });
    await a.create({ name: `Room ${id}`, entityTypeId: a.locationType, parentId: flat.id });

    await login(page);
    await page.goto(`/location/${place.id}`);
    await expect(page.getByText(`Shelf ${id}`)).toBeVisible();
    await expect(page.getByText(`Ladder ${id}`)).toHaveCount(0);
    await page.getByTestId("jump-direct-items").click();
    await expect(page.getByText(`Ladder ${id}`)).toBeVisible();

    // No direct items: neither the hint nor an empty item list.
    await page.goto(`/location/${flat.id}`);
    await expect(page.getByText(`Room ${id}`)).toBeVisible();
    await expect(page.getByTestId("jump-direct-items")).toHaveCount(0);
    await expect(page.getByTestId("toggle-direct-items")).toHaveCount(0);
  });

  test("changes a quantity offline and syncs it later", async ({ page, context, request }) => {
    const a = await api(request);
    const item = await a.create({ name: `Offline ${uid()}`, entityTypeId: a.itemType });

    await login(page);
    await page.goto(`/item/${item.id}`);
    const stepper = page.getByTestId("quantity-stepper");
    await expect(stepper).toContainText("1");
    await page.waitForLoadState("networkidle");

    await context.setOffline(true);
    await stepper.getByRole("button", { name: "+1" }).click();
    await expect(stepper).toContainText("2");
    await expect(page.getByTestId("offline-pending-count").filter({ visible: true })).toHaveText("1");
    expect((await a.get(item.id)).quantity).toBe(1);

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await a.get(item.id)).quantity, { timeout: 20_000 }).toBe(2);
    await expect(page.getByTestId("offline-pending-count")).toHaveCount(0, { timeout: 20_000 });
  });
});
