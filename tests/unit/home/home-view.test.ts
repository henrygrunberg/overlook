import { describe, expect, it } from "vitest";
import { buildLibrary } from "../../../src/bookmarks/library";
import { DEFAULT_SETTINGS, type HomeSettings } from "../../../src/settings/settings";
import { bookmarkNamed, folderNamed, sampleLibrary } from "../fixtures/sample-library";
import { UsageStore } from "../../../src/usage/usage-store";
import { memoryStorage } from "../fixtures/memory-storage";
import { frequentSection, homeView, type HomeView } from "../../../src/home/home-view";

const NOW = Date.UTC(2026, 9, 28);
const FAVOURITES_HOME = DEFAULT_SETTINGS.home;

async function usageWith(urls: readonly string[]): Promise<UsageStore> {
  const store = await UsageStore.load(memoryStorage().storage);
  for (const url of urls) await store.recordVisit(url, NOW);
  return store;
}

const titlesOf = (bookmarks: readonly { title: string }[]) =>
  bookmarks.map((bookmark) => bookmark.title);

function sections(view: HomeView) {
  if (view.kind !== "sections") throw new Error(`Expected sections, got ${view.kind}`);
  return view.sections;
}

describe("frequentSection", () => {
  it("shows the newest bookmarks before anything has been opened", async () => {
    const section = frequentSection(sampleLibrary, await usageWith([]), new Set(), NOW);

    expect(section.title).toBe("Recently added");
    expect(section.bookmarks).toHaveLength(8);
    expect(section.bookmarks[0]?.title).toBe("Gear shop");
  });

  it("puts the most-used bookmarks first and tops up with the newest", async () => {
    const usage = await usageWith([
      "https://trails.example.com/",
      "https://github.com/",
      "https://github.com/",
    ]);
    const section = frequentSection(sampleLibrary, usage, new Set(), NOW);

    expect(section.title).toBe("Frequent");
    expect(titlesOf(section.bookmarks).slice(0, 2)).toEqual(["GitHub", "Trail map"]);
    expect(new Set(titlesOf(section.bookmarks)).size).toBe(8);
  });

  it("says when the most-used links are topped up with the newest", async () => {
    const used = sampleLibrary.bookmarks.map((bookmark) => bookmark.url);
    const noteFor = async (urls: readonly string[]) =>
      frequentSection(sampleLibrary, await usageWith(urls), new Set(), NOW).note;

    expect(await noteFor(used.slice(0, 2))).toBe("Your most-used links, then the newest");
    expect(await noteFor(used.slice(0, 8))).toBe("Your most-used links");
    expect(await noteFor([])).toBe("Your most-used links will show up here");
  });

  it("ignores usage of bookmarks that were deleted since", async () => {
    const usage = await usageWith(["https://deleted.example/"]);
    expect(frequentSection(sampleLibrary, usage, new Set(), NOW).title).toBe("Recently added");
  });

  it("leaves out the excluded bookmarks", async () => {
    const github = bookmarkNamed("GitHub");
    const usage = await usageWith([github.url]);
    const section = frequentSection(sampleLibrary, usage, new Set([github.url]), NOW);
    expect(titlesOf(section.bookmarks)).not.toContain("GitHub");
  });
});

describe("homeView", () => {
  it("shows favourites in their saved order", async () => {
    const pinned = [bookmarkNamed("Trail map"), bookmarkNamed("GitHub")];
    const [favourites] = sections(
      homeView(sampleLibrary, await usageWith([]), FAVOURITES_HOME, pinned, NOW),
    );

    expect(favourites.id).toBe("favourites");
    expect(titlesOf(favourites.bookmarks)).toEqual(["Trail map", "GitHub"]);
  });

  it("follows favourites with frequent links that aren't pinned", async () => {
    const github = bookmarkNamed("GitHub");
    const usage = await usageWith([github.url]);
    const [, frequent] = sections(homeView(sampleLibrary, usage, FAVOURITES_HOME, [github], NOW));

    expect(frequent?.id).toBe("frequent");
    expect(titlesOf(frequent?.bookmarks ?? [])).not.toContain("GitHub");
  });

  it("doesn't repeat a pinned link through another bookmark of the same URL", async () => {
    const library = buildLibrary([
      {
        id: "0",
        title: "",
        children: [
          {
            id: "1",
            title: "Bookmarks bar",
            children: [
              { id: "10", title: "Docs", url: "https://docs.example.com/" },
              {
                id: "11",
                title: "Work",
                children: [{ id: "12", title: "Docs", url: "https://docs.example.com/" }],
              },
            ],
          },
        ],
      },
    ]);
    const usage = await usageWith(["https://docs.example.com/"]);
    const pinned = library.bookmarks.filter((bookmark) => bookmark.id === "10");
    const view = homeView(library, usage, FAVOURITES_HOME, pinned, NOW);

    expect(sections(view).flatMap((section) => titlesOf(section.bookmarks))).toEqual(["Docs"]);
  });

  it("leaves out the frequent links when every bookmark is pinned", async () => {
    const view = homeView(
      sampleLibrary,
      await usageWith([]),
      FAVOURITES_HOME,
      sampleLibrary.bookmarks,
      NOW,
    );
    expect(sections(view).map((section) => section.id)).toEqual(["favourites"]);
  });

  it("still says how to add bookmarks when there are none", async () => {
    const empty = buildLibrary([]);
    const view = homeView(empty, await usageWith([]), FAVOURITES_HOME, [], NOW);
    const [favourites, frequent] = sections(view);
    expect(frequent?.emptyText).toMatch(/^No bookmarks yet/);
    expect(favourites.emptyText).not.toMatch(/hover|click/i);
  });

  it("shows only favourites when frequent links are turned off", async () => {
    const home: HomeSettings = { ...FAVOURITES_HOME, showFrequent: false };
    const view = homeView(sampleLibrary, await usageWith([]), home, [], NOW);
    expect(sections(view).map((section) => section.id)).toEqual(["favourites"]);
  });

  it("can show frequent links alone", async () => {
    const home: HomeSettings = { ...FAVOURITES_HOME, source: "frequent" };
    const view = homeView(sampleLibrary, await usageWith([]), home, [], NOW);
    expect(sections(view).map((section) => section.id)).toEqual(["frequent"]);
  });

  it("can show a folder, and falls back to favourites once it is deleted", async () => {
    const usage = await usageWith([]);
    const work = folderNamed("Work");
    const home: HomeSettings = { ...FAVOURITES_HOME, source: "folder", folderId: work.id };

    expect(homeView(sampleLibrary, usage, home, [], NOW)).toEqual({ kind: "folder", folder: work });
    const gone = homeView(sampleLibrary, usage, { ...home, folderId: "deleted" }, [], NOW);
    expect(sections(gone)[0].id).toBe("favourites");
  });
});
