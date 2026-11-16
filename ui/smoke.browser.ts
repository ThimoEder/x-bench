import { expect, test } from "./testing/browserHost.ts";

test("the page loads, a message is sent and the agent's reply shows", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Chat" }).click();
  await page.getByRole("complementary").getByRole("button", { name: "New chat" }).click();

  const main = page.getByRole("main");
  await main.getByRole("textbox").fill("ping");
  await main.getByRole("button", { name: "Send" }).click();

  await expect(main.getByRole("article").filter({ hasText: "ping" })).toBeVisible();
  await expect(main.getByRole("article").filter({ hasText: "pong" })).toBeVisible();
  // The fake agent's last message of the turn is its suggestion for the next prompt.
  await expect(main.getByRole("textbox", { name: "and then?" })).toBeVisible();
  await expect(page).toHaveScreenshot("smoke.png");
});
