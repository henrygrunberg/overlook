import { describe, expect, it } from "vitest";
import type { Bookmark } from "../../../src/bookmarks/library";
import type { IconSource } from "../../../src/favicons/icon-library";
import type { LabelRule } from "../../../src/settings/settings";
import { bookmarkNamed } from "../fixtures/sample-library";
import { linkCard, refreshIconTiles, type BookmarkDecor } from "../../../src/ui/link-card";

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

  it("leaves a password in the address out of the tooltip, but not out of the link", () => {
    const login = { ...bookmarkNamed("GitHub"), url: "https://user:pw@login.example.com/" };
    const link = linkCard(login, "host", decor).querySelector("a");
    expect(link?.title).toBe("GitHub\nhttps://login.example.com/");
    expect(link?.getAttribute("href")).toBe("https://user:pw@login.example.com/");
  });

  it("lets the browser pick the direction of the title and the detail", () => {
    const card = linkCard(bookmarkNamed("GitHub"), "host", decor);
    for (const text of card.querySelectorAll(".link-card__title, .link-card__detail")) {
      expect(text.getAttribute("dir")).toBe("auto");
    }
  });

  it("shows two labels and counts the rest in a chip that names them", () => {
    const labels: LabelRule[] = ["VPN", "Work", "Docs", "Legacy"].map((text, index) => ({
      id: String(index),
      text,
      color: "blue",
      privateNetwork: false,
      hosts: [],
    }));
    const card = linkCard(bookmarkNamed("GitHub"), "host", { ...decor, labels });
    const chips = [...card.querySelectorAll(".chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["VPN", "Work", "+2Docs, Legacy"]);
    const more = card.querySelector(".label-chip--more");
    expect(more?.getAttribute("title")).toBe("Docs, Legacy");
    expect(more?.querySelector("[aria-hidden=true]")?.textContent).toBe("+2");
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
