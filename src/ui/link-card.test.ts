import { describe, expect, it, vi } from "vitest";
import type { Bookmark } from "../bookmarks/library";
import type { IconSource } from "../favicons/icon-library";
import { bookmarkNamed } from "../test/sample-library";
import { linkCard, refreshIconTiles, type BookmarkDecor } from "./link-card";

vi.stubGlobal("chrome", {
  runtime: { getURL: (path: string) => `chrome-extension://overlook-test${path}` },
});
const icons: IconSource = { iconFor: () => ({ kind: "none" }) };
const decor: BookmarkDecor = { color: "#0a84ff", labels: [], icons, pinned: false, canPin: true };

describe("linkCard", () => {
  it.each([
    ["  docs", "D"],
    ["🚀 Launch", "🚀"],
    ["👩‍💻 Dev notes", "👩‍💻"],
    ["🇪🇺 Travel", "🇪🇺"],
    ["   ", "•"],
  ])("gives %j the monogram %j", (title, expected) => {
    const card = linkCard({ ...bookmarkNamed("GitHub"), title }, "host", decor);
    expect(card.querySelector(".favicon-tile")?.textContent).toBe(expected);
  });
});

describe("refreshIconTiles", () => {
  it("redraws only the announced site's tiles, each for its own bookmark", () => {
    const github = bookmarkNamed("GitHub");
    const code: Bookmark = { ...github, id: "code", title: "Code" };
    const jira = bookmarkNamed("Jira board");
    const root = document.createElement("div");
    root.append(...[github, code, jira].map((bookmark) => linkCard(bookmark, "host", decor)));
    const byId = new Map([github, code, jira].map((bookmark) => [bookmark.id, bookmark]));
    const redrawn: string[] = [];
    const recording: IconSource = {
      iconFor: (url) => {
        redrawn.push(url);
        return { kind: "none" };
      },
    };

    refreshIconTiles(root, new URL(github.url).origin, recording, (id) => byId.get(id));

    expect(redrawn).toEqual([github.url, github.url]);
    const monograms = [...root.querySelectorAll(".favicon-tile")].map((tile) => tile.textContent);
    expect(monograms).toEqual(["G", "C", "J"]);
  });
});
