import { beforeEach, describe, expect, it, vi } from "vitest";
import blockRules from "../../../public/private-rules.json";
import type { BookmarkNode } from "../../../src/bookmarks/library";
import {
  allowBookmarkedPrivateSites,
  blockPrivateSites,
} from "../../../src/favicons/private-origin-rules";

type Rule = chrome.declarativeNetRequest.Rule;

let rules: Rule[];
let bookmarkUrls: string[];
const updateDynamicRules = vi.fn(
  ({ removeRuleIds = [], addRules = [] }: chrome.declarativeNetRequest.UpdateRuleOptions) => {
    const added = new Set(addRules.map((rule) => rule.id));
    if (rules.some((rule) => added.has(rule.id))) {
      return Promise.reject(new Error("Rule ids must be unique"));
    }
    rules = [...rules.filter((rule) => !removeRuleIds.includes(rule.id)), ...addRules];
    return Promise.resolve();
  },
);

const bookmarkTree = (): BookmarkNode[] => [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        title: "Bookmarks bar",
        children: bookmarkUrls.map((url, index) => ({ id: `b${index}`, title: "Acme", url })),
      },
    ],
  },
];

beforeEach(() => {
  rules = [];
  bookmarkUrls = [];
  updateDynamicRules.mockClear();
  vi.stubGlobal("chrome", {
    runtime: { id: "overlook" },
    bookmarks: { getTree: () => Promise.resolve(bookmarkTree()) },
    declarativeNetRequest: {
      getDynamicRules: () => Promise.resolve(rules),
      updateDynamicRules,
    },
  });
});

const allowedHosts = () => rules.map((rule) => rule.condition.requestDomains);

const allowBookmarked = (urls: string[]) => {
  bookmarkUrls = urls;
  return allowBookmarkedPrivateSites();
};

describe("allowBookmarkedPrivateSites", () => {
  it("allows each bookmarked private host on any port or scheme, and nothing public", async () => {
    await allowBookmarked([
      "http://10.0.0.20:3000/d/x",
      "https://10.0.0.20/d/y",
      "http://router/",
      "https://docs.example.com/",
    ]);
    expect(rules).toEqual([
      {
        id: 1,
        priority: 2,
        action: { type: "allow" },
        condition: { requestDomains: ["10.0.0.20"], initiatorDomains: ["overlook"] },
      },
      {
        id: 2,
        priority: 2,
        action: { type: "allow" },
        condition: { requestDomains: ["router"], initiatorDomains: ["overlook"] },
      },
    ]);
  });

  it("removes the rules of hosts no longer bookmarked and keeps the rest", async () => {
    await allowBookmarked(["http://router/", "http://nas.local/"]);
    await allowBookmarked(["http://nas.local:5001/", "http://192.168.1.5/"]);
    expect(rules.map((rule) => [rule.id, rule.condition.requestDomains])).toEqual([
      [2, ["nas.local"]],
      [3, ["192.168.1.5"]],
    ]);
  });

  it("changes nothing when the rules are already right", async () => {
    await allowBookmarked(["http://router/"]);
    await allowBookmarked(["http://router/"]);
    expect(updateDynamicRules).toHaveBeenCalledOnce();
  });

  it("applies overlapping updates one after another", async () => {
    bookmarkUrls = ["http://router/", "http://nas.local/"];
    await Promise.all([allowBookmarkedPrivateSites(), allowBookmarkedPrivateSites()]);
    expect(allowedHosts()).toEqual([["router"], ["nas.local"]]);
  });

  it("recovers after a failed update", async () => {
    updateDynamicRules.mockRejectedValueOnce(new Error("quota"));
    await expect(allowBookmarked(["http://router/"])).rejects.toThrow("quota");
    await allowBookmarked(["http://router/"]);
    expect(allowedHosts()).toEqual([["router"]]);
  });
});

describe("blockPrivateSites", () => {
  it("removes every allow rule", async () => {
    await allowBookmarked(["http://router/", "http://nas.local/"]);
    await blockPrivateSites();
    expect(rules).toEqual([]);
  });

  it("changes nothing when no site is allowed", async () => {
    await blockPrivateSites();
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });
});

describe("the static rules", () => {
  // Chrome matches regexFilter without regard to case unless a rule asks otherwise.
  const blocked = (url: string) =>
    blockRules.some((rule) => new RegExp(rule.condition.regexFilter, "i").test(url));

  it.each([
    "192.168.0.10",
    "10.0.0.8",
    "172.31.255.1",
    "169.254.1.1",
    "100.64.0.1",
    "0.1.2.3",
    "127.0.0.1:8080",
    "[::1]",
    "[::]",
    "[::ffff:c0a8:101]",
    "[::7f00:1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "router",
    "localhost.",
    "nas.local",
    "printer.local.:631",
    "app.localhost",
    "wiki.corp.internal",
    "nas.home.arpa",
    "u@10.0.0.8",
    "u@[::1]",
    "u@router",
    "u:pw@nas.local",
  ])("block the extension's requests to %s", (host) => {
    expect(blocked(new URL(`http://${host}/x`).href)).toBe(true);
    expect(blocked(new URL(`https://${host}/`).href)).toBe(true);
  });

  it.each([
    "172.32.0.1",
    "github.com",
    "8.8.8.8",
    "100.128.0.1",
    "[2001:db8::1]",
    "localhost.com",
    "example.com.",
    "local.example.com",
  ])("let requests to %s through", (host) => {
    expect(blocked(new URL(`https://${host}/favicon.ico`).href)).toBe(false);
  });

  it("apply only to the extension's own requests", () => {
    for (const rule of blockRules) {
      expect(rule.condition.initiatorDomains).toEqual(["imabhmapeefoacmhgemijamhnfcnbdoa"]);
    }
  });
});
