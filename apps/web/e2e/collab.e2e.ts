import { expect, test, type Browser, type Page } from "@playwright/test";

async function signedIn(browser: Browser, url = "/"): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("Content Security Policy"))
      throw new Error(`CSP violation: ${m.text()}`);
  });
  await page.goto(url);
  await page
    .getByPlaceholder("you@example.com")
    .fill(`${crypto.randomUUID()}@e2e.test`);
  await page.getByPlaceholder("password").fill("password123");
  await page.getByRole("button", { name: "Create account" }).click();
  return page;
}

const board = (page: Page) => page.getByRole("img", { name: /^Whiteboard/ });

async function expectShapes(page: Page, n: number): Promise<void> {
  await expect(board(page)).toHaveAccessibleName(`Whiteboard, ${n} shapes`);
}

async function drag(
  page: Page,
  tool: string,
  x: number,
  y: number,
): Promise<void> {
  await page.getByRole("button", { name: tool, exact: true }).click();
  const box = (await board(page).boundingBox())!;
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 80, box.y + y + 60, { steps: 5 });
  await page.mouse.up();
}

async function ownerWithLinks(browser: Browser) {
  const owner = await signedIn(browser);
  await owner.getByRole("button", { name: "New board" }).click();
  await expectShapes(owner, 0);
  await owner.getByRole("button", { name: "Share" }).click();
  const editor = await owner.getByLabel("editor link").inputValue();
  const viewer = await owner.getByLabel("viewer link").inputValue();
  return { owner, editor, viewer };
}

test("edits converge across three browsers, including one that went offline", async ({
  browser,
}) => {
  const { owner, editor } = await ownerWithLinks(browser);
  const b = await signedIn(browser, editor);
  const c = await signedIn(browser, editor);
  for (const p of [b, c]) await expect(p.getByText("live")).toBeVisible();

  await drag(owner, "Rect", 40, 40);
  for (const p of [owner, b, c]) await expectShapes(p, 1);

  await b.context().setOffline(true);
  await expect(b.getByText("offline — edits saved locally")).toBeVisible();
  await drag(b, "Ellipse", 200, 40);
  await drag(c, "Rect", 40, 200);
  await expectShapes(b, 2);
  await expectShapes(owner, 2);

  await b.context().setOffline(false);
  for (const p of [owner, b, c]) await expectShapes(p, 3);
});

test("a viewer link cannot change the board", async ({ browser }) => {
  const { owner, viewer } = await ownerWithLinks(browser);
  const v = await signedIn(browser, viewer);
  await expect(v.getByText("live")).toBeVisible();
  await drag(v, "Rect", 40, 40);
  await drag(owner, "Ellipse", 200, 40);
  await expectShapes(v, 1);
  await owner.reload();
  await expectShapes(owner, 1);
});

test("markup typed into a text shape is drawn, never executed", async ({
  browser,
}) => {
  const page = await signedIn(browser);
  await page.getByRole("button", { name: "New board" }).click();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const box = (await board(page).boundingBox())!;
  await page.mouse.click(box.x + 100, box.y + 100);
  await page
    .getByPlaceholder("type, then press Enter")
    .fill(`<img src=x onerror="document.title='pwned'">`);
  await page.keyboard.press("Enter");
  await expectShapes(page, 1);
  await expect(page.locator("img")).toHaveCount(0);
  expect(await page.title()).not.toBe("pwned");
});

test("a second tab of the same browser waits instead of sharing an actor", async ({
  browser,
}) => {
  const first = await signedIn(browser);
  await first.getByRole("button", { name: "New board" }).click();
  await expectShapes(first, 0);
  const second = await first.context().newPage();
  await second.goto(first.url());
  await expect(
    second.getByText("This board is open in another tab"),
  ).toBeVisible();
  await first.close();
  await expectShapes(second, 0);
});
