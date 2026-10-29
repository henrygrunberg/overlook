import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  MAX_FAVOURITES,
  moveFavourite,
  parseHostPatterns,
  parseSettings,
  sameBackground,
  toggleFavourite,
} from "./settings";

describe("parseSettings", () => {
  it("returns the defaults for nothing stored", () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid settings", () => {
    const settings = {
      background: { kind: "photo", photo: "still-lake" },
      labels: [
        { id: "a", text: "Work", color: "blue", privateNetwork: false, hosts: ["*.acme.com"] },
      ],
      home: { source: "folder", folderId: "42", showFrequent: false },
      favourites: ["7", "3"],
      focusSearchOnOpen: false,
    };
    expect(parseSettings(settings)).toEqual(settings);
  });

  it("falls back to favourites for an unknown Home source", () => {
    expect(parseSettings({ home: { source: "everything" } }).home.source).toBe("favourites");
  });

  it("drops duplicate and invalid favourites", () => {
    expect(parseSettings({ favourites: ["1", "1", 2, "", "3"] }).favourites).toEqual(["1", "3"]);
  });

  it("falls back per field when something is malformed", () => {
    const parsed = parseSettings({
      background: { kind: "photo", photo: "moon" },
      labels: [
        { id: "a", text: "  Work  ", color: "neon", hosts: ["ACME.com", 7, ""] },
        { id: "b", text: "   " },
        "nonsense",
      ],
    });
    expect(parsed.background).toEqual({ kind: "auto" });
    expect(parsed.labels).toEqual([
      { id: "a", text: "Work", color: "gray", privateNetwork: false, hosts: ["acme.com"] },
    ]);
  });

  it("allows removing every label", () => {
    expect(parseSettings({ labels: [] }).labels).toEqual([]);
  });

  it("caps label length and count", () => {
    const labels = Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      text: "A very long label indeed",
      color: "red",
    }));
    const parsed = parseSettings({ labels });
    expect(parsed.labels).toHaveLength(20);
    expect(parsed.labels[0]?.text).toBe("A very long labe");
  });

  it("keeps only the first label with a given id", () => {
    const labels = parseSettings({
      labels: [
        { id: "a", text: "One", hosts: [] },
        { id: "a", text: "Two", hosts: [] },
      ],
    }).labels;
    expect(labels.map((label) => label.text)).toEqual(["One"]);
  });

  it("drops host patterns longer than any host name", () => {
    const labels = parseSettings({
      labels: [{ id: "x", text: "X", hosts: ["a".repeat(300), "ok.example.com"] }],
    }).labels;
    expect(labels[0]?.hosts).toEqual(["ok.example.com"]);
  });

  it("reads custom backgrounds saved before upload times were stored", () => {
    expect(parseSettings({ background: { kind: "custom" } }).background).toEqual({
      kind: "custom",
      savedAt: 0,
    });
  });
});

describe("sameBackground", () => {
  it("treats a re-uploaded custom image as a change", () => {
    expect(sameBackground({ kind: "custom", savedAt: 1 }, { kind: "custom", savedAt: 2 })).toBe(
      false,
    );
    expect(sameBackground({ kind: "custom", savedAt: 1 }, { kind: "custom", savedAt: 1 })).toBe(
      true,
    );
  });

  it("compares photos by id and other kinds by kind", () => {
    expect(
      sameBackground(
        { kind: "photo", photo: "still-lake" },
        { kind: "photo", photo: "golden-haze" },
      ),
    ).toBe(false);
    expect(sameBackground({ kind: "auto" }, { kind: "auto" })).toBe(true);
    expect(sameBackground({ kind: "auto" }, { kind: "dynamic" })).toBe(false);
  });
});

describe("toggleFavourite", () => {
  it("pins to the end and unpins in place", () => {
    expect(toggleFavourite(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggleFavourite(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("doesn't pin past the limit, but still unpins", () => {
    const full = Array.from({ length: MAX_FAVOURITES }, (_, index) => String(index));
    expect(toggleFavourite(full, "new")).toEqual(full);
    expect(toggleFavourite(full, "0")).toHaveLength(MAX_FAVOURITES - 1);
  });
});

describe("moveFavourite", () => {
  it("moves a favourite to a new position", () => {
    expect(moveFavourite(["a", "b", "c", "d"], "d", 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveFavourite(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("clamps the position and ignores ids that aren't favourites", () => {
    expect(moveFavourite(["a", "b"], "a", 99)).toEqual(["b", "a"]);
    expect(moveFavourite(["a", "b"], "a", -5)).toEqual(["a", "b"]);
    expect(moveFavourite(["a", "b"], "zzz", 0)).toEqual(["a", "b"]);
  });
});

describe("parseHostPatterns", () => {
  it("accepts one pattern per line or comma-separated", () => {
    expect(parseHostPatterns("Jira.acme.com\n*.atlassian.net,  10.*  ")).toEqual([
      "jira.acme.com",
      "*.atlassian.net",
      "10.*",
    ]);
  });

  it("keeps only the host of pasted links", () => {
    expect(
      parseHostPatterns(
        "https://Jira.acme.com:8443/browse/X-1 http://10.0.0.5/admin?x=1 https://me@git.acme.com/",
      ),
    ).toEqual(["jira.acme.com", "10.0.0.5", "git.acme.com"]);
  });

  it("keeps wildcards with a URL parser that percent-encodes them, as Chromium's does", () => {
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        override get hostname() {
          return super.hostname.replaceAll("*", "%2A");
        }
      },
    );
    try {
      expect(parseHostPatterns("*.acme.com 10.*")).toEqual(["*.acme.com", "10.*"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("matches the form of bookmark host names for international names and IPv6", () => {
    expect(parseHostPatterns("bücher.example *.bücher.example fd00::1 [fd00::2]:8080")).toEqual([
      "xn--bcher-kva.example",
      "*.xn--bcher-kva.example",
      "[fd00::1]",
      "[fd00::2]",
    ]);
  });

  it("brackets wildcard IPv6 and keeps only its host", () => {
    expect(parseHostPatterns("fd00::* https://[fd00::*]/x [FD00:1::*]:8080")).toEqual([
      "[fd00::*]",
      "[fd00::*]",
      "[fd00:1::*]",
    ]);
  });
});
