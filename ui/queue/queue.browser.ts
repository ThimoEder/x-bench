import { expect, SEED, test } from "../testing/browserHost.ts";

test.use({ seeded: true });

test("a parent's sub-tickets start as a run: the sheet names the order, and the run's folder shows the main chat and what is queued", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("complementary").getByRole("button", { name: SEED.project, exact: true }).click();
  await expect(page.getByText("6 tickets")).toBeVisible();
  await page.getByRole("article").filter({ hasText: SEED.tickets.parent }).click();
  await page.getByTestId("run-queue").click();

  const sheet = page.getByRole("dialog", { name: "Run sub-tickets" });
  await expect(sheet.getByTestId("queue-plan").getByRole("listitem")).toHaveText(["Main chatDefault", `2${SEED.tickets.done}Done`, `3${SEED.tickets.review}after 4Default`]);

  await sheet.getByTestId("queue-prompt").click();
  const prompt = page.getByRole("dialog", { name: "Chat for this ticket" });
  await expect(prompt.getByRole("textbox", { name: "Prompt" })).toHaveValue(/^Implement this ticket\./);
  await prompt.getByRole("textbox", { name: "Prompt" }).fill("Only check the label colors.");
  await prompt.getByRole("button", { name: "Save" }).click();
  await expect(prompt).toBeHidden();
  await expect(sheet.getByTestId("queue-prompt")).toHaveAttribute("title", "Prompt edited");
  await sheet.getByTestId("queue-prompt").click();
  await expect(prompt.getByRole("textbox", { name: "Prompt" })).toHaveValue("Only check the label colors.");
  await page.keyboard.press("Escape");
  await expect(prompt).toBeHidden();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("queue-outside").getByRole("listitem")).toHaveText([`4${SEED.tickets.active}Not queued`]);
  await sheet.getByRole("radio", { name: "PR open" }).click();
  await expect(sheet).toHaveScreenshot("sheet.png");
  await sheet.getByTestId("queue-start").click();
  await expect(sheet).toBeHidden();

  const folder = page.locator("li.folder");
  await expect(folder.getByTestId("folder-count")).toHaveText("1 / 2");
  await expect(folder.getByTestId("chat-tag")).toHaveText("Main");
  await expect(folder.getByTestId("queue-wait")).toHaveText(`${SEED.tickets.review}after 4`);
  await expect(folder.locator(".status-dot.working")).toBeHidden();
  await expect(folder).toHaveScreenshot("folder.png");

  await folder.getByRole("button", { name: `Folder actions for ${SEED.tickets.parent}` }).click();
  await page.getByRole("menuitem", { name: "End run" }).click();
  await expect(folder.getByTestId("folder-count")).toHaveText("1");
  await expect(folder.getByTestId("queue-wait")).toBeHidden();
});

test("a ticket that does not start shows as an event line in the main chat, and the folder offers to start it again", async ({ page }) => {
  await page.goto("/");
  // The seeded project is no git repository, so the sub-ticket's worktree fails once its blocker is done.
  await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>('meta[name="x-bench-token"]')?.content ?? "";
    await fetch("/api/board/move", { method: "POST", headers: { "Content-Type": "application/json", "X-Bench-Token": token }, body: JSON.stringify({ taskId: 4, status: "done" }) });
  });
  await page.getByRole("complementary").getByRole("button", { name: SEED.project, exact: true }).click();
  await expect(page.getByText("6 tickets")).toBeVisible();
  await page.getByRole("article").filter({ hasText: SEED.tickets.parent }).click();
  await page.getByTestId("run-queue").click();
  const sheet = page.getByRole("dialog", { name: "Run sub-tickets" });
  await expect(sheet.getByTestId("queue-outside").getByRole("listitem")).toHaveText([`4${SEED.tickets.active}Done`]);
  await sheet.getByTestId("queue-start").click();
  await expect(sheet).toBeHidden();

  const folder = page.locator("li.folder");
  await expect(folder.getByTestId("queue-wait")).toHaveText(`${SEED.tickets.review}Start again`);
  await folder.getByTestId("chat-tag").click();
  const main = page.getByRole("main");
  await expect(main.getByTestId("user-message")).toHaveText([/^Queue run for ticket 1, "Ship the board"\./]);
  const event = main.getByTestId("task-completed");
  await expect(event).toContainText("Ticket did not start");
  await expect(event).toContainText(`Ticket 3, "${SEED.tickets.review}", did not start`);
  await expect(main.getByRole("article").filter({ hasText: "pong" })).toHaveCount(2);
  await expect(event).toHaveScreenshot("event.png");

  // Removing the run's folder ends the run, so the parent can run again.
  await folder.getByRole("button", { name: `Folder actions for ${SEED.tickets.parent}` }).click();
  await page.getByRole("menuitem", { name: "Remove folder" }).click();
  await expect(folder).toBeHidden();
  await page.getByRole("complementary").getByRole("button", { name: SEED.project, exact: true }).click();
  await page.getByRole("article").filter({ hasText: SEED.tickets.parent }).click();
  await page.getByTestId("run-queue").click();
  await sheet.getByTestId("queue-start").click();
  await expect(sheet).toBeHidden();
  await expect(folder.getByTestId("folder-count")).toHaveText("1 / 2");
});
