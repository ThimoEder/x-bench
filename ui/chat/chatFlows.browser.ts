import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../testing/browserHost.ts";

async function newChat(page: Page): Promise<Locator> {
  await page.goto("/");
  await page.getByRole("tab", { name: "Chat" }).click();
  await page.getByRole("complementary").getByRole("button", { name: "New chat" }).click();
  return page.getByRole("main");
}

// The fake agent's HANG turn says "working" and runs until it is stopped.
async function startHangingTurn(main: Locator) {
  await main.getByRole("textbox").fill("HANG");
  await main.getByRole("button", { name: "Send" }).click();
  await expect(main.getByRole("article").filter({ hasText: "working" })).toBeVisible();
}

async function deliverBy(main: Locator, choice: string) {
  await main.getByRole("button", { name: "Message delivery" }).click();
  await main.getByRole("option", { name: choice }).click();
}

test("a stopped turn ends and the composer sends again", async ({ page }) => {
  const main = await newChat(page);
  await startHangingTurn(main);

  await main.getByRole("button", { name: "Stop" }).click();
  await expect(main.getByRole("button", { name: "Stop" })).toBeHidden();

  await main.getByRole("textbox").fill("ping");
  await main.getByRole("button", { name: "Send" }).click();
  await expect(main.getByRole("article").filter({ hasText: "pong" })).toBeVisible();
});

test("a message queued during a turn waits in the queue and goes out once the turn ends", async ({ page }) => {
  const main = await newChat(page);
  await startHangingTurn(main);

  await deliverBy(main, "Queue");
  await main.getByRole("textbox").fill("ping");
  await main.getByRole("button", { name: "Queue message" }).click();
  await expect(main.getByTestId("queue-row")).toHaveText(/ping/);
  await expect(main.getByRole("article").filter({ hasText: "ping" })).toBeHidden();

  await main.getByRole("button", { name: "Stop" }).click();
  await expect(main.getByTestId("queue-row")).toBeHidden();
  await expect(main.getByRole("article").filter({ hasText: "ping" })).toBeVisible();
  await expect(main.getByRole("article").filter({ hasText: "pong" })).toBeVisible();
});

test("a steer joins the running turn", async ({ page }) => {
  const main = await newChat(page);
  await startHangingTurn(main);

  await deliverBy(main, "Steer");
  await main.getByRole("textbox").fill("turn left");
  await main.getByRole("button", { name: "Steer", exact: true }).click();

  await expect(main.getByRole("article").filter({ hasText: "(steered: turn left)" })).toBeVisible();
  await expect(main.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(main.getByTestId("queue-row")).toBeHidden();
});

test("a chat switches to another model and keeps it across a reload", async ({ page }) => {
  const main = await newChat(page);
  await main.getByRole("textbox").fill("ping");
  await main.getByRole("button", { name: "Send" }).click();
  await expect(main.getByRole("article").filter({ hasText: "pong" })).toBeVisible();

  const model = main.getByRole("button", { name: "Model", exact: true });
  await expect(model).toHaveText("Model One");
  await model.click();
  await main.getByRole("option", { name: "Model Two" }).click();
  await expect(model).toHaveText("Model Two");

  await page.reload();
  await expect(page.getByRole("main").getByRole("button", { name: "Model", exact: true })).toHaveText("Model Two");
});
