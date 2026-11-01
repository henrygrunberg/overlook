import { describe, expect, it } from "vitest";
import { buildLibrary, type BookmarkNode } from "../../../src/bookmarks/library";
import { bookmarkNamed, folderNamed, sampleLibrary } from "../fixtures/sample-library";
import { SearchIndex } from "../../../src/search/search-index";

const index = new SearchIndex(sampleLibrary);

let nextId = 0;
const bookmark = (title: string): BookmarkNode => ({
  id: String(nextId++),
  title,
  url: `https://site${nextId}.example.com/`,
});
const folder = (title: string, children: BookmarkNode[]): BookmarkNode => ({
  id: String(nextId++),
  title,
  children,
});
function indexOf(...nodes: BookmarkNode[]): SearchIndex {
  return new SearchIndex(
    buildLibrary([
      { id: "root", title: "", children: [{ id: "bar", title: "Bar", children: nodes }] },
    ]),
  );
}
const titlesIn = (search: SearchIndex, query: string) =>
  search.search(query).bookmarks.map((hit) => hit.item.title);
const bookmarkTitles = (query: string) =>
  index.search(query).bookmarks.map((hit) => hit.item.title);
const folderTitles = (query: string) => index.search(query).folders.map((hit) => hit.item.title);

describe("SearchIndex", () => {
  it("matches title prefixes first", () => {
    expect(bookmarkTitles("graf").slice(0, 2)).toEqual(["IoT Grafana", "Load testing Grafana"]);
  });

  it.each([
    ["a missing letter", "grafna", "IoT Grafana"],
    ["swapped letters", "gtihub", "GitHub"],
    ["a wrong letter", "geer", "Gear shop"],
    ["two typos in a long word", "confluemse", "Confluence"],
  ])("tolerates %s", (_label, query, expected) => {
    expect(bookmarkTitles(query)).toContain(expected);
  });

  it("ignores accents", () => {
    expect(bookmarkTitles("analuutika")).toEqual(["Café analüütika"]);
  });

  it("matches acronyms of the title", () => {
    expect(bookmarkTitles("ltg")[0]).toBe("Load testing Grafana");
  });

  it("matches the host and the folder path", () => {
    expect(bookmarkTitles("atlassian")).toEqual(
      expect.arrayContaining(["Jira board", "Confluence"]),
    );
    expect(bookmarkTitles("work jira")).toEqual(["Jira board"]);
    expect(bookmarkTitles("dashboards")).toEqual(
      expect.arrayContaining(["IoT Grafana", "Load testing Grafana"]),
    );
  });

  it("matches inside words and loose letter sequences", () => {
    expect(bookmarkTitles("rail")).toEqual(["Trail map"]);
    expect(bookmarkTitles("hndbk")).toContain("Data handbook");
  });

  it("finds bookmarks by their labels", () => {
    const labelled = new SearchIndex(sampleLibrary, (bookmark) =>
      bookmark.isPrivateNetwork ? ["VPN"] : [],
    );
    expect(
      labelled
        .search("vpn")
        .bookmarks.map((hit) => hit.item.title)
        .sort(),
    ).toEqual(["IoT Grafana", "Load testing Grafana"]);
  });

  it("requires every word of the query to match", () => {
    expect(bookmarkTitles("grafana gear")).toEqual([]);
  });

  it("returns nothing for gibberish", () => {
    expect(index.search("qqxv")).toEqual({ folders: [], bookmarks: [] });
  });

  it("finds folders at any depth", () => {
    expect(folderTitles("dash")).toEqual(["Dashboards"]);
    expect(folderTitles("outdoors")).toEqual(["Outdoors"]);
  });

  it("limits results to a scope folder", () => {
    const work = folderNamed("Work");
    const scoped = index.search("grafana", { scopeFolderId: work.id });
    expect(scoped.bookmarks.map((hit) => hit.item.title)).toEqual(
      expect.arrayContaining(["IoT Grafana", "Load testing Grafana"]),
    );
    expect(index.search("github", { scopeFolderId: work.id }).bookmarks).toEqual([]);
  });

  it("lists the whole scope when the query is empty", () => {
    const results = index.search("", { scopeFolderId: folderNamed("Work").id, bookmarkLimit: 50 });
    expect(results.bookmarks).toHaveLength(4);
    expect(results.folders.map((hit) => hit.item.title)).toEqual(["Dashboards"]);
  });

  it("returns nothing for an empty query without a scope", () => {
    expect(index.search("   ")).toEqual({ folders: [], bookmarks: [] });
  });

  it("scores folders and bookmarks alike, so an exact title beats a loose folder match", () => {
    const library = indexOf(
      bookmark("News"),
      bookmark("Map"),
      folder("Networks & Systems", [bookmark("Router")]),
      folder("Maps", [bookmark("Trails")]),
    );
    for (const [query, title] of [
      ["news", "News"],
      ["map", "Map"],
    ]) {
      const { folders, bookmarks } = library.search(query ?? "");
      expect(bookmarks[0]?.item.title).toBe(title);
      expect(bookmarks[0]?.score).toBeGreaterThan(folders[0]?.score ?? 0);
    }
    const dash = index.search("dash");
    expect(dash.folders[0]?.score).toBeGreaterThan(dash.bookmarks[0]?.score ?? 0);
  });

  it.each([
    ["jira-board", "Jira board"],
    ["o'reilly", "O’Reilly Learning"],
  ])("splits a query on punctuation the way titles are split (%s)", (query, title) => {
    const library = indexOf(bookmark("Jira board"), bookmark("O’Reilly Learning"), bookmark("Jam"));
    const [top] = library.search(query).bookmarks;
    expect(top?.item.title).toBe(title);
    expect(top?.score).toBeGreaterThanOrEqual(1);
  });

  it("keeps a query that is only a letter and punctuation whole", () => {
    const library = indexOf(bookmark("C++ reference"), bookmark("Calendar"), bookmark("🚀 Launch"));
    expect(titlesIn(library, "c++")).toEqual(["C++ reference"]);
    expect(titlesIn(library, "🚀")).toEqual(["🚀 Launch"]);
  });

  it("tells apart words that differ only in vowel signs", () => {
    const library = indexOf(bookmark("कमल"), bookmark("कोमल"));
    const [first, second] = library.search("कोमल").bookmarks;
    expect(first?.item.title).toBe("कोमल");
    expect(first?.score).toBeGreaterThan(second?.score ?? 0);
  });

  it("finds one ideograph or emoji inside a title, but not one Latin letter", () => {
    const library = indexOf(bookmark("東京大学"), bookmark("❤️ Favorites"), bookmark("Banana"));
    expect(titlesIn(library, "京")).toEqual(["東京大学"]);
    expect(titlesIn(library, "❤️")).toEqual(["❤️ Favorites"]);
    expect(titlesIn(library, "n")).toEqual([]);
  });

  it("ranks a match inside a word above a typo", () => {
    expect(titlesIn(indexOf(bookmark("Raid notes"), bookmark("Trail map")), "rail")).toEqual([
      "Trail map",
      "Raid notes",
    ]);
  });

  it("ranks a title that starts with the query first", () => {
    expect(titlesIn(indexOf(bookmark("Alpha gear"), bookmark("Gear shop")), "gear")).toEqual([
      "Gear shop",
      "Alpha gear",
    ]);
  });

  it("tolerates a typo in the part of a word typed so far", () => {
    expect(bookmarkTitles("grafx")).toContain("IoT Grafana");
  });

  it("lets usage boost the ranking", () => {
    const loadTesting = bookmarkNamed("Load testing Grafana");
    const boosted = index.search("grafana", {
      bookmarkBoost: (bookmark) => (bookmark.id === loadTesting.id ? 0.3 : 0),
    });
    expect(boosted.bookmarks[0]?.item.title).toBe("Load testing Grafana");
  });
});

describe("SearchIndex performance", () => {
  it("searches 10 000 bookmarks well within a keystroke", () => {
    const words = ["alpha", "beta", "gamma", "delta", "omega", "kappa", "sigma", "lambda"];
    const folders: BookmarkNode[] = Array.from({ length: 100 }, (_, f) => ({
      id: `f${f}`,
      title: `${words[f % 8] ?? ""} folder ${f}`,
      children: Array.from({ length: 100 }, (_, b) => ({
        id: `b${f}-${b}`,
        title: `${words[(f + b) % 8] ?? ""} ${words[b % 8] ?? ""} page ${b}`,
        url: `https://${words[b % 8] ?? ""}${b}.example.com/${f}`,
      })),
    }));
    const big = new SearchIndex(
      buildLibrary([
        { id: "0", title: "", children: [{ id: "1", title: "Bar", children: folders }] },
      ]),
    );
    const queries = ["a", "al", "alp", "alph", "alpha", "alpha p", "alpha pa", "alhpa pag", "zzzz"];

    const perQueryTimes = Array.from({ length: 5 }, () => {
      const start = performance.now();
      for (const query of queries) big.search(query);
      return (performance.now() - start) / queries.length;
    }).sort((a, b) => a - b);
    const median = perQueryTimes[Math.floor(perQueryTimes.length / 2)];

    expect(median).toBeLessThan(100);
  });
});
