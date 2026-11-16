import { expect, SEED, test } from "./browserHost.ts";

test.use({ seeded: true });

test("a seeded chat opens on its thinking, its tool calls and its steps", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("complementary").getByRole("button", { name: SEED.chats.tools, exact: true }).click();

  const main = page.getByRole("main");
  await expect(main.getByText("Here is every kind of tool call.")).toBeVisible();
  for (const row of ["Thought", "Read 1 file", "Edit", "Run Show what changed", "Searched 1 pattern", "Search the web", "Check the list", "chat_id", "Run npm test", "Change the list"]) {
    await expect(main.getByText(row).first()).toBeVisible();
  }
  await expect(page).toHaveScreenshot("seeded-chat.png");

  await page.getByRole("tab", { name: "Chat" }).click();
  await expect(page.getByRole("complementary").getByRole("button", { name: SEED.chats.chat, exact: true })).toBeVisible();
});

test("the seeded project's board shows a ticket in every column, and a ticket its comments", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("complementary").getByRole("button", { name: SEED.project, exact: true }).click();

  for (const title of Object.values(SEED.tickets)) await expect(page.getByRole("article").filter({ hasText: title })).toBeVisible();
  await page.getByRole("article").filter({ hasText: SEED.tickets.active }).click();
  await expect(page.getByText("Fixed in the bubble, the queue is next.")).toBeVisible();
});

test("a prompt brings up the permission card, the question card and the plan card", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("complementary").getByRole("button", { name: SEED.chats.text, exact: true }).click();

  const main = page.getByRole("main");
  const prompt = async (text: string) => {
    await main.getByRole("textbox").fill(text);
    await main.getByRole("button", { name: "Send" }).click();
  };

  await prompt("PERMISSION");
  await main.getByRole("button", { name: "Allow once" }).click();
  await expect(main.getByRole("article").filter({ hasText: "wrote" })).toBeVisible();

  await prompt("QUESTION");
  await expect(main.getByRole("heading", { name: "Which database?" })).toBeVisible();
  await main.getByRole("button", { name: "Postgres" }).click();
  await main.getByRole("button", { name: "Answer" }).click();
  await expect(main.getByRole("article").filter({ hasText: '"question_0":"Postgres"' })).toBeVisible();

  await prompt("PLANCARD");
  await expect(main.getByRole("heading", { name: "Rename the notes" })).toBeVisible();
  await main.getByRole("button", { name: "Approve" }).click();
  await expect(main.getByRole("article").filter({ hasText: '"optionId":"default"' })).toBeVisible();
});
