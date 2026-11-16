import type { Page } from "@playwright/test";
import { expect, SEED, test } from "../testing/browserHost.ts";

test.use({ seeded: true });

const card = (page: Page, title: string) => page.getByRole("article").filter({ hasText: title });
const column = (page: Page, status: string) => page.getByTestId(`column-${status}`);
const detail = (page: Page) => page.getByRole("complementary").filter({ has: page.getByRole("heading", { name: "Comments" }) });

async function openBoard(page: Page) {
  await page.goto("/");
  await page.getByRole("complementary").getByRole("button", { name: SEED.project, exact: true }).click();
  await expect(page.getByText("6 tickets")).toBeVisible();
}

test("a folder's board opens with every ticket in its column", async ({ page }) => {
  await openBoard(page);

  const { tickets } = SEED;
  for (const [status, titles] of Object.entries({ open: [tickets.open], active: [tickets.parent, tickets.active], review: [tickets.review], done: [tickets.done], unset: [tickets.unset] })) {
    await expect(column(page, status).getByRole("article").locator("strong")).toHaveText(titles);
  }
});

test("a ticket dragged to another column stays there after a reload", async ({ page }) => {
  await openBoard(page);

  await card(page, SEED.tickets.open).dragTo(column(page, "review"));
  await expect(column(page, "review").getByRole("article").locator("strong")).toHaveText([SEED.tickets.review, SEED.tickets.open]);
  await expect(column(page, "open").getByText("No tickets")).toBeVisible();

  await page.reload();
  await expect(column(page, "review").getByRole("article").locator("strong")).toHaveText([SEED.tickets.review, SEED.tickets.open]);
});

test("a ticket opens on its description, its note, its linked tickets, its comments and its chats", async ({ page }) => {
  await openBoard(page);

  await card(page, SEED.tickets.active).click();
  const pane = detail(page);
  await expect(pane.getByRole("heading", { name: SEED.tickets.active })).toBeVisible();
  for (const text of ["A long link runs out of the message bubble.", "Seen on a phone first.", "Fixed in the bubble, the queue is next."]) await expect(pane.getByText(text)).toBeVisible();
  await expect(pane.getByRole("button", { name: `blocks #3 ${SEED.tickets.review} review` })).toBeVisible();
  await expect(pane.getByRole("button", { name: SEED.chats.tools })).toBeVisible();

  await pane.getByRole("button", { name: "Close", exact: true }).click();
  await expect(pane).toBeHidden();
});

test("a ticket added to a column shows there with its number", async ({ page }) => {
  await openBoard(page);

  await page.getByRole("button", { name: "Add a ticket to review" }).click();
  await page.getByRole("textbox", { name: "New ticket in review" }).fill("Count the tickets");
  await page.keyboard.press("Enter");

  await expect(column(page, "review").getByRole("article").filter({ hasText: "Count the tickets" })).toContainText("#7");
  await expect(page.getByText("7 tickets")).toBeVisible();
});

test("a comment shows under the ticket's other comments", async ({ page }) => {
  await openBoard(page);
  await card(page, SEED.tickets.active).click();

  const pane = detail(page);
  await pane.getByRole("textbox", { name: "Comment" }).fill("Wrapped in the queue too.");
  await pane.getByRole("button", { name: "Comment" }).click();

  await expect(pane.getByRole("heading", { name: "Comments 3" })).toBeVisible();
  await expect(pane.getByRole("paragraph").filter({ hasText: /queue/ })).toHaveText(["It also happens in the queue.", "Fixed in the bubble, the queue is next.", "Wrapped in the queue too."]);
  await expect(pane.getByRole("textbox", { name: "Comment" })).toBeEmpty();
});

test("a label picked or dropped in the ticket changes its card", async ({ page }) => {
  await openBoard(page);
  await card(page, SEED.tickets.active).click();

  await detail(page).getByRole("button", { name: "Label", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Labels" });
  await menu.getByRole("menuitemcheckbox", { name: "design" }).click();
  await menu.getByRole("menuitemcheckbox", { name: "bug" }).click();
  await expect(menu.getByRole("menuitemcheckbox", { checked: true })).toHaveText(["design"]);

  await expect(card(page, SEED.tickets.active)).toContainText("design");
  await expect(card(page, SEED.tickets.active)).not.toContainText("bug");
});

test("the board settings list the columns, and a column hidden there leaves the board", async ({ page }) => {
  await openBoard(page);

  await page.getByRole("button", { name: "Board settings", exact: true }).click();
  const settings = page.getByRole("complementary", { name: "Board settings" });
  await expect(settings.getByRole("listitem")).toHaveText([/open/, /active/, /review/, /done/, /unset/]);
  await expect(settings.getByRole("combobox", { name: "Work starts" })).toHaveValue("active");

  await settings.getByRole("button", { name: "Hide done" }).click();
  await expect(column(page, "done")).toBeHidden();
  await expect(page.getByRole("button", { name: "1 hidden column" })).toBeVisible();

  await settings.getByRole("button", { name: "Close board settings" }).click();
  await expect(settings).toBeHidden();
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const [width, viewport] of Object.entries({ desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } })) {
    test.describe(`${colorScheme}, ${width}`, () => {
      test.use({ colorScheme, viewport });

      test("the board, a ticket and the board settings look as they should", async ({ page }) => {
        await openBoard(page);
        await expect(page).toHaveScreenshot(`board-${colorScheme}-${width}.png`);

        await card(page, SEED.tickets.active).click();
        await expect(detail(page).getByText("Fixed in the bubble, the queue is next.")).toBeVisible();
        await expect(page).toHaveScreenshot(`ticket-${colorScheme}-${width}.png`);
        await detail(page).getByRole("button", { name: "Close", exact: true }).click();

        await page.getByRole("button", { name: "Board settings", exact: true }).click();
        await expect(page.getByRole("complementary", { name: "Board settings" })).toBeVisible();
        await expect(page).toHaveScreenshot(`settings-${colorScheme}-${width}.png`);
      });
    });
  }
}
