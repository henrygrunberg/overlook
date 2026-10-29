import type { Page } from "@playwright/test";
import { solidPng } from "./fake-sites.ts";
import { expect, test } from "./fixtures.ts";

const openSettings = async (page: Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
};

test.describe("settings", () => {
  test("opens from the button or the , key and closes with Escape", async ({ newTab }) => {
    await openSettings(newTab);
    await newTab.keyboard.press("Escape");
    await expect(newTab.getByRole("dialog")).toBeHidden();

    await newTab.keyboard.press(",");
    await expect(newTab.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });

  test("switches to a bundled photo and remembers it", async ({ newTab }) => {
    const dialog = await openSettings(newTab);
    await expect(dialog.getByRole("button", { name: /Dynamic wallpaper/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await dialog.getByRole("button", { name: /Still lake/ }).click();
    await expect(newTab.locator("#wallpaper")).toHaveAttribute(
      "data-background",
      "photo:still-lake",
    );
    await expect(dialog.getByRole("button", { name: /Still lake/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await newTab.reload();
    await expect(newTab.locator("#wallpaper")).toHaveAttribute(
      "data-background",
      "photo:still-lake",
    );
  });

  test("keeps an uploaded background after a reload and shows it in other tabs", async ({
    newTab,
    newTabUrl,
  }) => {
    const otherTab = await newTab.context().newPage();
    await otherTab.goto(newTabUrl);
    const otherFrame = otherTab.locator(".wallpaper__frame.is-visible");
    await expect(otherTab.locator("#wallpaper")).toHaveAttribute("data-state", "ready");

    const dialog = await openSettings(newTab);
    const upload = (name: string, rgba: readonly [number, number, number, number]) =>
      dialog.getByLabel("Choose a background image").setInputFiles({
        name,
        mimeType: "image/png",
        buffer: solidPng(64, rgba),
      });
    await upload("mine.png", [30, 90, 160, 255]);
    await expect(newTab.locator("#wallpaper")).toHaveAttribute("data-background", "custom");
    await expect(otherTab.locator("#wallpaper")).toHaveAttribute("data-background", "custom");
    await expect(otherFrame).toHaveAttribute("src", /^blob:/);

    const first = await otherFrame.getAttribute("src");
    await upload("replacement.png", [200, 120, 30, 255]);
    await expect(otherFrame).not.toHaveAttribute("src", first ?? "");
    await expect(otherFrame).toHaveAttribute("src", /^blob:/);

    await newTab.reload();
    await expect(newTab.locator("#wallpaper")).toHaveAttribute("data-background", "custom");
    await expect(newTab.locator(".wallpaper__frame.is-visible")).toHaveAttribute("src", /^blob:/);
  });

  test("keeps a label whose name was cleared", async ({ newTab }) => {
    const dialog = await openSettings(newTab);
    await dialog.getByRole("button", { name: "Edit label VPN" }).click();
    const name = dialog.getByLabel("Label name");
    await name.fill("");
    await name.blur();
    await expect(name).toHaveValue("VPN");
    await newTab.keyboard.press("Escape");

    await newTab.getByRole("button", { name: /^Work/ }).click();
    await expect(
      newTab
        .getByRole("main")
        .getByRole("link", { name: /IoT Grafana/ })
        .locator(".chip"),
    ).toHaveText("VPN");
  });

  test("rejects files that aren't images", async ({ newTab }) => {
    const dialog = await openSettings(newTab);
    await dialog.getByLabel("Choose a background image").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    await expect(dialog.getByRole("alert")).toHaveText("Choose an image file.");
  });

  test("adds a label with addresses typed and pasted as chips", async ({ newTab }) => {
    const dialog = await openSettings(newTab);
    await dialog.getByRole("button", { name: "New label" }).click();
    const row = dialog.locator(".label-row").last();
    await row.getByLabel("Label name").fill("Atlassian");
    await row.getByLabel("blue").click();

    const addresses = row.getByLabel("Addresses tagged Atlassian");
    await addresses.fill("https://acme.atlassian.net/jira");
    await addresses.press("Enter");
    await addresses.evaluate((input) => {
      const paste = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      paste.clipboardData?.setData("text/plain", "*.atlassian.net\nstatus.acme.com");
      input.dispatchEvent(paste);
    });
    await expect(row.locator(".host-chip")).toHaveText([
      "acme.atlassian.net",
      "*.atlassian.net",
      "status.acme.com",
    ]);

    // Removing a chip while an address is half typed adds that address and removes the chip.
    await addresses.fill("wiki.acme.com");
    await row.getByRole("button", { name: "Remove status.acme.com" }).click();
    await addresses.press("Enter");
    await expect(row.locator(".host-chip")).toHaveText([
      "acme.atlassian.net",
      "*.atlassian.net",
      "wiki.acme.com",
    ]);
    await expect(row.locator(".label-row__summary")).toHaveText("3 addresses");
    await newTab.keyboard.press("Escape");

    await newTab.getByRole("button", { name: /^Work/ }).click();
    const jira = newTab.getByRole("main").getByRole("link", { name: /Jira board/ });
    await expect(jira.locator(".chip")).toHaveText("Atlassian");
    await expect(jira.locator(".chip")).toHaveClass(/chip--blue/);
  });

  test("renames and deletes the VPN label", async ({ newTab }) => {
    await newTab.getByRole("button", { name: /^Work/ }).click();
    const grafana = newTab.getByRole("main").getByRole("link", { name: /IoT Grafana/ });
    await expect(grafana.locator(".chip")).toHaveText("VPN");

    const dialog = await openSettings(newTab);
    await dialog.getByRole("button", { name: "Edit label VPN" }).click();
    await dialog.getByLabel("Label name").fill("Office");
    await expect(dialog.locator(".label-row .chip")).toHaveText("Office");
    await newTab.keyboard.press("Escape");
    await expect(grafana.locator(".chip")).toHaveText("Office");

    await openSettings(newTab);
    await dialog.getByRole("button", { name: "Edit label Office" }).click();
    await dialog.getByRole("button", { name: "Delete label" }).click();
    await newTab.keyboard.press("Escape");
    await expect(grafana.locator(".chip")).toHaveCount(0);
  });

  test("shows a folder on Home", async ({ newTab }) => {
    const dialog = await openSettings(newTab);
    await dialog.getByRole("radio", { name: /A folder/ }).check();
    await dialog.getByLabel("Folder to show on Home").selectOption({ label: "Outdoors" });
    await newTab.keyboard.press("Escape");

    const panel = newTab.getByRole("main");
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Outdoors");
    await newTab.reload();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Outdoors");
    await expect(
      newTab.getByRole("navigation").getByRole("button", { name: "Home" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("remembers what Home shows after a reload", async ({ newTab }) => {
    const panel = newTab.getByRole("main");
    const dialog = await openSettings(newTab);
    const showFrequent = dialog.getByRole("checkbox", {
      name: "Show your most-used links below them",
    });
    await showFrequent.uncheck();
    await expect(panel.getByRole("heading", { level: 3 })).toHaveCount(0);

    await newTab.reload();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Favourites");
    await expect(panel.getByRole("heading", { level: 3 })).toHaveCount(0);
    await openSettings(newTab);
    await expect(showFrequent).not.toBeChecked();

    await dialog.getByRole("radio", { name: /^Frequent/ }).check();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Recently added");
    await newTab.reload();
    await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Recently added");
    await expect(panel.locator(".link-card")).toHaveCount(8);
  });
});
