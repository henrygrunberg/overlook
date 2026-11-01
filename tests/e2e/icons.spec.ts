import type { Page } from "@playwright/test";
import { PUBLIC_LOOKING_HOST, solidPng, type FakeSites } from "./fake-sites.ts";
import { expect, seedBookmarks, test } from "./fixtures.ts";

const cardTile = (page: Page, title: string) =>
  page.getByRole("link", { name: new RegExp(title) }).locator(".favicon-tile");

interface StoredIcon {
  readonly status: string;
  readonly failedAttempts: number;
}

const storedRecord = (page: Page, origin: string) =>
  page.evaluate(
    (key) =>
      new Promise<StoredIcon | null>((resolve, reject) => {
        const opening = indexedDB.open("overlook");
        opening.onerror = () => {
          reject(new Error("cannot open the database"));
        };
        opening.onsuccess = () => {
          const read = opening.result.transaction("icons").objectStore("icons").get(key);
          read.onsuccess = () => {
            const record = read.result as { status: string; failedAttempts?: number } | undefined;
            resolve(
              record ? { status: record.status, failedAttempts: record.failedAttempts ?? 0 } : null,
            );
          };
        };
      }),
    origin,
  );

const storedStatus = async (page: Page, origin: string) =>
  (await storedRecord(page, origin))?.status ?? null;

const removeBookmark = (page: Page, url: string) =>
  page.evaluate(async (bookmarkUrl) => {
    const [bookmark] = await chrome.bookmarks.search({ url: bookmarkUrl });
    if (!bookmark) throw new Error(`No bookmark for ${bookmarkUrl}`);
    await chrome.bookmarks.remove(bookmark.id);
  }, url);

const requestsFor = (fakeSites: FakeSites, url: string, path: string) =>
  fakeSites.requests.filter((request) => request === `${new URL(url).port}${path}`);

const hasBrowserFavicon = (page: Page, pageUrl: string) =>
  page.evaluate(async (url) => {
    const faviconBytes = async (forPage: string) => {
      const address = new URL(chrome.runtime.getURL("/_favicon/"));
      address.searchParams.set("pageUrl", forPage);
      const response = await fetch(address);
      return new Uint8Array(await response.arrayBuffer()).join();
    };
    // The .invalid TLD never resolves, so the browser answers with its generic icon.
    return (await faviconBytes(url)) !== (await faviconBytes("https://overlook.invalid/"));
  }, pageUrl);

const touchIconSite = {
  html: '<html><head><link rel="apple-touch-icon" href="/touch.png"></head></html>',
  files: { "/touch.png": solidPng(180, [220, 60, 40, 255]) },
};

test.describe("site icons", () => {
  test("downloads a sharp icon for a new bookmark and keeps it across reloads", async ({
    newTab,
    fakeSites,
  }) => {
    const url = await fakeSites.add(touchIconSite);
    await seedBookmarks(newTab, [{ title: "Local app", url }]);

    const tile = cardTile(newTab, "Local app");
    await expect(tile.locator("img")).toHaveAttribute("src", /^blob:/);
    await expect(tile).toHaveClass(/favicon-tile--full-bleed/);
    expect(requestsFor(fakeSites, url, "/touch.png")).toHaveLength(1);

    await newTab.reload();
    await expect(cardTile(newTab, "Local app").locator("img")).toHaveAttribute("src", /^blob:/);
  });

  test("downloads every icon again when asked to in Settings", async ({ newTab, fakeSites }) => {
    const url = await fakeSites.add(touchIconSite);
    await seedBookmarks(newTab, [{ title: "Local app", url }]);
    const image = cardTile(newTab, "Local app").locator("img");
    await expect(image).toHaveAttribute("src", /^blob:/);
    const firstSrc = await image.getAttribute("src");

    await newTab.getByRole("button", { name: "Settings" }).click();
    await newTab.getByRole("button", { name: "Download icons again" }).click();
    await expect.poll(() => requestsFor(fakeSites, url, "/touch.png")).toHaveLength(2);
    // The open tab swaps in the new download instead of keeping the old, now revoked, URL.
    await expect.poll(() => image.getAttribute("src")).not.toBe(firstSrc);
    await expect(image).toHaveAttribute("src", /^blob:/);
  });

  test("keeps the old icon when a refresh can't reach the site", async ({ newTab, fakeSites }) => {
    const url = await fakeSites.add(touchIconSite);
    const origin = new URL(url).origin;
    await seedBookmarks(newTab, [{ title: "Local app", url }]);
    await expect
      .poll(() => storedRecord(newTab, origin))
      .toEqual({
        status: "ok",
        failedAttempts: 0,
      });

    await fakeSites.stop(url);
    await newTab.getByRole("button", { name: "Settings" }).click();
    await newTab.getByRole("button", { name: "Download icons again" }).click();
    await expect
      .poll(() => storedRecord(newTab, origin))
      .toEqual({
        status: "ok",
        failedAttempts: 1,
      });

    await newTab.reload();
    await expect(cardTile(newTab, "Local app").locator("img")).toHaveAttribute("src", /^blob:/);
  });

  test("keeps the browser's favicon when a new bookmark's site can't be reached", async ({
    context,
    newTab,
    fakeSites,
  }) => {
    const url = await fakeSites.add({
      html: '<head><link rel="icon" href="/tab.png"></head>',
      files: { "/tab.png": solidPng(16, [0, 120, 255, 255]) },
    });
    const visit = await context.newPage();
    await visit.goto(url);
    await expect.poll(() => hasBrowserFavicon(newTab, url)).toBe(true);
    await visit.close();
    await fakeSites.stop(url);

    await seedBookmarks(newTab, [{ title: "Intranet app", url }]);
    await expect.poll(() => storedStatus(newTab, new URL(url).origin)).toBe("unreachable");
    await newTab.reload();
    const tile = cardTile(newTab, "Intranet app");
    await expect(tile.locator("img")).toHaveAttribute("src", /\/_favicon\//);
    await expect(tile).not.toHaveClass(/favicon-tile--monogram/);
  });

  test("centres icons with transparent corners instead of filling the tile", async ({
    newTab,
    fakeSites,
  }) => {
    const url = await fakeSites.add({
      html: '<head><link rel="icon" sizes="64x64" href="/logo.png"></head>',
      files: { "/logo.png": solidPng(64, [0, 0, 0, 0]) },
    });
    await seedBookmarks(newTab, [{ title: "Transparent", url }]);

    const tile = cardTile(newTab, "Transparent");
    await expect(tile.locator("img")).toHaveAttribute("src", /^blob:/);
    await expect(tile).not.toHaveClass(/favicon-tile--full-bleed/);
  });

  test("never follows a page's icon link to another private-network host", async ({
    newTab,
    fakeSites,
  }) => {
    const router = await fakeSites.add({
      html: "<title>Router</title>",
      files: { "/reboot.png": solidPng(180, [0, 0, 0, 255]) },
    });
    const url = await fakeSites.add({
      html: `<head><link rel="apple-touch-icon" href="${router}reboot.png"></head>`,
      files: {},
    });
    const routerPort = new URL(router).port;
    await seedBookmarks(newTab, [{ title: "Sneaky", url }]);

    await expect.poll(() => storedStatus(newTab, new URL(url).origin)).toBe("missing");
    expect(requestsFor(fakeSites, url, "/")).not.toHaveLength(0);
    expect(fakeSites.requests.filter((request) => request.startsWith(`${routerPort}/`))).toEqual(
      [],
    );
  });

  // The real risk is a public site redirecting to a router. All FakeSites listen on 127.0.0.1, so
  // the redirecting site gets a host name the extension sees as public, and the private site
  // stands in for the router: the browser must cancel every redirect before it reaches it.
  test("never lets a public site's redirect reach a private host", async ({
    newTab,
    fakeSites,
  }) => {
    const router = await fakeSites.add({
      html: '<head><link rel="apple-touch-icon" href="/touch.png"></head>',
      files: {
        "/touch.png": solidPng(180, [0, 0, 0, 255]),
        "/apple-touch-icon.png": solidPng(180, [0, 0, 0, 255]),
      },
    });
    const url = await fakeSites.addRedirect(PUBLIC_LOOKING_HOST, router);
    await seedBookmarks(newTab, [{ title: "Redirecting", url }]);

    const origin = new URL(url).origin;
    await expect.poll(() => storedStatus(newTab, origin)).not.toBeNull();
    expect(await storedStatus(newTab, origin)).not.toBe("ok");
    expect(requestsFor(fakeSites, url, "/")).not.toHaveLength(0);
    const routerPort = new URL(router).port;
    expect(fakeSites.requests.filter((request) => request.startsWith(`${routerPort}/`))).toEqual(
      [],
    );
  });

  test("forgets a removed bookmark's icon once the removal settles", async ({
    newTab,
    fakeSites,
  }) => {
    const keptUrl = await fakeSites.add(touchIconSite);
    const url = await fakeSites.add(touchIconSite);
    const kept = new URL(keptUrl).origin;
    const origin = new URL(url).origin;
    await seedBookmarks(newTab, [
      { title: "Kept app", url: keptUrl },
      { title: "Short-lived", url },
    ]);
    await expect.poll(() => storedStatus(newTab, kept)).toBe("ok");
    await expect.poll(() => storedStatus(newTab, origin)).toBe("ok");

    await removeBookmark(newTab, url);
    await expect.poll(() => storedStatus(newTab, origin)).toBeNull();
    expect(await storedStatus(newTab, kept)).toBe("ok");
  });

  test("gets the icon of an intranet site that moves to another port", async ({
    newTab,
    fakeSites,
  }) => {
    const movedTo = await fakeSites.add({
      html: "<title>Acme NAS</title>",
      files: { "/apple-touch-icon.png": solidPng(180, [0, 90, 200, 255]) },
    });
    const url = await fakeSites.addRedirect("127.0.0.1", movedTo);
    await seedBookmarks(newTab, [{ title: "NAS", url }]);

    await expect.poll(() => storedStatus(newTab, new URL(url).origin)).toBe("ok");
    expect(requestsFor(fakeSites, movedTo, "/apple-touch-icon.png")).not.toHaveLength(0);
  });

  // The browser lets the extension reach a bookmarked private site, but can't tell a request
  // for it from a public site's redirect, so no public site is fetched while that's allowed.
  test("never lets a public site's redirect reach a bookmarked private site", async ({
    newTab,
    fakeSites,
  }) => {
    const router = await fakeSites.add(touchIconSite);
    const url = await fakeSites.addRedirect(PUBLIC_LOOKING_HOST, `${router}from-public/`);
    await seedBookmarks(newTab, [
      { title: "Router", url: router },
      { title: "Redirecting", url },
    ]);

    await expect.poll(() => storedStatus(newTab, new URL(router).origin)).toBe("ok");
    await expect.poll(() => storedStatus(newTab, new URL(url).origin)).not.toBeNull();
    expect(requestsFor(fakeSites, url, "/")).not.toHaveLength(0);
    const routerPort = new URL(router).port;
    expect(
      fakeSites.requests.filter((request) => request.startsWith(`${routerPort}/from-public/`)),
    ).toEqual([]);
  });

  test("follows a placeholder home page's script redirect to its icon", async ({
    newTab,
    fakeSites,
  }) => {
    const url = await fakeSites.add({
      html: "<head><title>Untitled</title></head><script>window.location = '/app/home';</script>",
      pages: { "/app/home": '<head><link rel="icon" sizes="192x192" href="/app-icon.png"></head>' },
      files: { "/app-icon.png": solidPng(192, [20, 120, 220, 255]) },
    });
    await seedBookmarks(newTab, [{ title: "Old portal", url }]);

    await expect(cardTile(newTab, "Old portal").locator("img")).toHaveAttribute("src", /^blob:/);
    expect(requestsFor(fakeSites, url, "/app-icon.png")).toHaveLength(1);
  });

  test("shows a letter instead of a blurry 16px favicon", async ({ newTab, fakeSites }) => {
    const url = await fakeSites.add({
      html: '<head><link rel="icon" href="/tiny.png"></head>',
      files: { "/tiny.png": solidPng(16, [0, 120, 255, 255]) },
    });
    await seedBookmarks(newTab, [{ title: "Tiny icon", url }]);

    await expect.poll(() => storedStatus(newTab, new URL(url).origin)).toBe("missing");
    // It really looked at the icon and rejected it, rather than failing to reach the site.
    expect(requestsFor(fakeSites, url, "/tiny.png")).not.toHaveLength(0);
    await newTab.reload();
    await expect(cardTile(newTab, "Tiny icon")).toHaveText("T");
    await expect(cardTile(newTab, "Tiny icon")).toHaveClass(/favicon-tile--monogram/);
  });
});
