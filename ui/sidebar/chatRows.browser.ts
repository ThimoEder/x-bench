import type { Page } from "@playwright/test";
import { expect, SEED, test } from "../testing/browserHost.ts";

test.use({ seeded: true });

const row = (page: Page) => page.getByRole("complementary").getByRole("listitem").filter({ hasText: SEED.chats.text });

async function chatAction(page: Page, name: string) {
  await page.getByRole("button", { name: `Chat actions for ${SEED.chats.text}` }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("an archived chat leaves the list, shows with the archived threads and comes back unarchived", async ({ page }) => {
  await page.goto("/");
  await chatAction(page, "Archive");
  await expect(row(page)).toBeHidden();
  await expect(page.getByRole("complementary").getByRole("button", { name: SEED.chats.tools, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Show archived threads" }).click();
  await expect(row(page).getByRole("img", { name: "Archived" })).toBeVisible();

  await chatAction(page, "Unarchive");
  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Show archived threads" }).click();
  await expect(row(page)).toBeVisible();
});

test("a deleted chat is gone for good, after a second click that confirms it", async ({ page }) => {
  await page.goto("/");
  await chatAction(page, "Delete");
  await expect(row(page)).toBeVisible();
  await page.getByRole("menuitem", { name: "Delete this chat" }).click();
  await expect(row(page)).toBeHidden();

  await page.reload();
  await expect(page.getByRole("complementary").getByRole("button", { name: SEED.chats.tools, exact: true })).toBeVisible();
  await expect(row(page)).toBeHidden();
});

test("a chat started in a project answers and joins the project's chats", async ({ page }) => {
  await page.goto("/");
  const chats = page.getByRole("complementary").getByRole("button", { name: /^Chat actions for / });
  await expect(chats).toHaveCount(2);
  // The project's tools show on hover.
  await page.getByRole("complementary").getByRole("button", { name: SEED.project, exact: true }).hover();
  await page.getByRole("button", { name: `New chat in ${SEED.project}` }).click();

  const main = page.getByRole("main");
  await main.getByRole("textbox").fill("ping");
  await main.getByRole("button", { name: "Send" }).click();
  await expect(main.getByRole("article").filter({ hasText: "pong" })).toBeVisible();
  await expect(chats).toHaveCount(3);
});
