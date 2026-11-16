import type { Page } from "@playwright/test";
import { expect, SEED, test } from "../testing/browserHost.ts";

test.use({ seeded: true });

const PHONE = { width: 390, height: 844 };

for (const look of ["light", "dark", "phone-light", "phone-dark"] as const) {
  test.describe(look, () => {
    test.use({ colorScheme: look.endsWith("dark") ? "dark" : "light", ...(look.startsWith("phone") ? { viewport: PHONE } : {}) });

    async function shot(page: Page, name: string) {
      // Parked in the corner, the pointer hovers over no row.
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`${name}-${look}.png`);
    }

    async function open(page: Page, chat: string, lastLine: string) {
      await page.goto("/");
      await page.getByRole("complementary").getByRole("button", { name: chat, exact: true }).click();
      const main = page.getByRole("main");
      // The shelf's branch chip shows while the chat loads, goes as the transcript comes in, and then comes back.
      await expect(main.getByText(lastLine)).toBeVisible();
      await expect(main.getByTestId("branch-menu")).toBeVisible();
      return main;
    }

    test("the transcript shows thinking, tool rows and a failed call, closed and open", async ({ page }) => {
      const main = await open(page, SEED.chats.tools, "The tests did not run");
      await shot(page, "transcript");

      for (const row of ["Thought", "Run Show what changed", "Check the list", "Run npm test"]) await main.getByText(row).first().click();
      await main.getByTestId("transcript").evaluate((list) => list.scrollTo(0, 0));
      await shot(page, "transcript-open");
    });

    test("each card shows, and leaves its receipt once answered", async ({ page }) => {
      const main = await open(page, SEED.chats.text, "And once more: ping");
      const prompt = async (text: string) => {
        await main.getByRole("textbox").fill(text);
        await main.getByRole("button", { name: "Send" }).click();
      };

      await prompt("QUESTION");
      await expect(main.getByRole("heading", { name: "Which database?" })).toBeVisible();
      await shot(page, "question");
      await main.getByRole("button", { name: "Postgres" }).click();
      await main.getByRole("button", { name: "Answer" }).click();
      await expect(main.getByRole("article").filter({ hasText: '"question_0":"Postgres"' })).toBeVisible();

      await prompt("PLANCARD");
      await expect(main.getByRole("heading", { name: "Rename the notes" })).toBeVisible();
      await shot(page, "plan");
      await main.getByRole("button", { name: "Approve" }).click();
      await expect(main.getByRole("article").filter({ hasText: '"optionId":"default"' })).toBeVisible();

      await prompt("PERMISSION");
      await expect(main.getByRole("button", { name: "Allow once" })).toBeVisible();
      await shot(page, "permission");
      await main.getByRole("button", { name: "Allow once" }).click();
      await expect(main.getByRole("article").filter({ hasText: "wrote" })).toBeVisible();
      await expect(main.getByPlaceholder("Ask anything")).toBeVisible();
      await shot(page, "receipts");
    });

    test("the composer opens each of its menus and the step list on its shelf", async ({ page }) => {
      const main = await open(page, SEED.chats.tools, "The tests did not run");

      const triggers = main.locator(".composer-bar [aria-haspopup]");
      await expect(triggers).not.toHaveCount(0);
      for (const id of await triggers.evaluateAll((all) => all.map((trigger) => trigger.getAttribute("data-testid")))) {
        await main.getByTestId(id ?? "").click();
        await shot(page, `menu-${id}`);
        await page.keyboard.press("Escape");
      }

      await main.getByRole("textbox").fill("/");
      await expect(main.getByTestId("slash-menu")).toBeVisible();
      await shot(page, "menu-slash");

      await main.getByRole("textbox").fill("@no");
      await expect(main.getByTestId("mentions")).toBeVisible();
      await shot(page, "menu-mentions");

      await main.getByRole("textbox").fill("");
      await main.getByTestId("shelf-plan").getByRole("button", { expanded: false }).click();
      await shot(page, "shelf-plan");
    });
  });
}
