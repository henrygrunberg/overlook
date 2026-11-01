import { describe, expect, it } from "vitest";
import {
  boundedEditDistance,
  normalize,
  splitWords,
  subsequenceScore,
} from "../../../src/search/text";

describe("normalize", () => {
  it("spells letters without a decomposition the way they're typed in ASCII", () => {
    expect(normalize("Straße Œuvres Ærø Łódź Đà Lạt Iğdır")).toBe(
      "strasse oeuvres aero lodz da lat igdir",
    );
  });

  it("strips accents from Latin, Greek and Cyrillic letters", () => {
    expect(normalize("Café analüütika Ελληνικά Ёлка İstanbul")).toBe(
      "cafe analuutika ελληνικα елка istanbul",
    );
  });

  it("keeps the marks that make a different word in other scripts", () => {
    expect(normalize("कोमल")).not.toBe(normalize("कमल"));
    expect(normalize("ガイド")).not.toBe(normalize("カイト"));
    expect(normalize("ไก่")).not.toBe(normalize("ไก"));
    expect(normalize("ｶﾞｲﾄﾞ")).toBe(normalize("ガイド"));
  });
});

describe("splitWords", () => {
  it("keeps vowel signs and voicing marks inside their word", () => {
    expect(splitWords(normalize("कोमल ガイド"))).toEqual([normalize("कोमल"), normalize("ガイド")]);
  });
});

describe("boundedEditDistance", () => {
  it.each([
    ["grafana", "grafana", 0],
    ["grafna", "grafana", 1],
    ["gtihub", "github", 1],
    ["geer", "gear", 1],
    ["kitten", "sitting", 3],
  ])("measures %s → %s as %i", (a, b, distance) => {
    expect(boundedEditDistance(a, b, 5)).toBe(distance);
  });

  it("gives up beyond the bound", () => {
    expect(boundedEditDistance("kitten", "sitting", 1)).toBe(2);
    expect(boundedEditDistance("a", "abcdef", 2)).toBe(3);
  });
});

describe("subsequenceScore", () => {
  it("is 1 for contiguous matches", () => {
    expect(subsequenceScore("flare", "cloudflare")).toBe(1);
  });

  it("prefers the tightest occurrence", () => {
    expect(subsequenceScore("ab", "a___b_ab")).toBe(1);
  });

  it("is 0 for an empty needle", () => {
    expect(subsequenceScore("", "cloudflare")).toBe(0);
  });

  it("drops towards 0 as letters spread out and is 0 when out of order", () => {
    expect(subsequenceScore("cf", "cloudflare")).toBeCloseTo(2 / 6);
    expect(subsequenceScore("fc", "cloudflare")).toBe(0);
  });
});
