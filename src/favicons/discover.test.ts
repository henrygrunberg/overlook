import { describe, expect, it } from "vitest";
import {
  conventionalIcons,
  findManifestIcons,
  findPageIcons,
  largestDeclaredSize,
  rankIcons,
} from "./discover";

const PAGE = "https://example.com/app/start";

describe("findPageIcons", () => {
  it("finds icon links of every common flavour", () => {
    const html = `<!doctype html><html><head>
      <link rel="shortcut icon" href="/favicon.ico">
      <link rel=icon type="image/png" sizes="32x32" href="icons/32.png">
      <link rel='apple-touch-icon' href='//cdn.example.com/touch.png?v=2&amp;x=1'>
      <LINK REL="icon" SIZES="16x16 192x192" HREF="https://example.com/big.png">
      <link rel="manifest" href="/site.webmanifest">
      <link rel="stylesheet" href="/style.css">
    </head><body><link rel="icon" href="/ignored-in-body.png"></body></html>`;

    expect(findPageIcons(html, PAGE)).toEqual({
      icons: [
        { url: "https://example.com/favicon.ico", size: 0 },
        { url: "https://example.com/app/icons/32.png", size: 32 },
        { url: "https://cdn.example.com/touch.png?v=2&x=1", size: 180 },
        { url: "https://example.com/big.png", size: 192 },
      ],
      manifestUrl: "https://example.com/site.webmanifest",
    });
  });

  it("survives out-of-range character references", () => {
    const html = '<head><link rel="icon" sizes="64x64" href="/a&#99999999;b&#x110000;.png"></head>';
    expect(findPageIcons(html, PAGE).icons).toEqual([
      { url: "https://example.com/a&#99999999;b&#x110000;.png", size: 64 },
    ]);
  });

  it("skips SVG icons, mask icons and unsafe URLs", () => {
    const html = `<head>
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="icon" href="/logo.svg?v=1">
      <link rel="mask-icon" href="/mask.png">
      <link rel="icon" href="javascript:alert(1)">
      <link rel="icon" href="data:image/png;base64,AAAA">
    </head>`;
    expect(findPageIcons(html, PAGE).icons).toEqual([]);
  });

  it("scans a page head full of unclosed <link tags in linear time", () => {
    const head = '<link rel="icon" href="/icon.png">' + "<link ".repeat(80_000);
    const started = performance.now();
    expect(findPageIcons(head, PAGE).icons).toEqual([
      { url: "https://example.com/icon.png", size: 0 },
    ]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("findManifestIcons", () => {
  it("resolves manifest icons relative to the manifest and skips monochrome and SVG", () => {
    const manifest = {
      icons: [
        { src: "android-192.png", sizes: "192x192", type: "image/png" },
        { src: "/mono.png", sizes: "512x512", purpose: "monochrome" },
        { src: "/vector.svg", sizes: "any", type: "image/svg+xml" },
        { src: 42 },
      ],
    };
    expect(findManifestIcons(manifest, "https://example.com/static/site.webmanifest")).toEqual([
      { url: "https://example.com/static/android-192.png", size: 192 },
    ]);
  });

  it("tolerates malformed manifests", () => {
    expect(findManifestIcons("nope", PAGE)).toEqual([]);
    expect(findManifestIcons({ icons: "nope" }, PAGE)).toEqual([]);
  });
});

describe("largestDeclaredSize", () => {
  it.each([
    [undefined, 0],
    ["16x16", 16],
    ["16x16 48x48 32x32", 48],
    ["any", 512],
    ["120x90", 90],
    ["garbage", 0],
  ])("reads %s as %i", (sizes, expected) => {
    expect(largestDeclaredSize(sizes)).toBe(expected);
  });
});

describe("rankIcons", () => {
  it("prefers icons near 192px, then mid-size, unknown and tiny ones", () => {
    const ranked = rankIcons([
      { url: "a-16", size: 16 },
      { url: "b-unknown", size: 0 },
      { url: "c-512", size: 512 },
      { url: "d-180", size: 180 },
      { url: "e-64", size: 64 },
      ...conventionalIcons("https://example.com"),
    ]);
    expect(ranked.map((icon) => icon.url)).toEqual([
      "d-180",
      "https://example.com/apple-touch-icon.png",
      "c-512",
      "e-64",
      "b-unknown",
      "https://example.com/favicon.ico",
      "a-16",
    ]);
  });

  it("drops duplicates, keeping the larger declared size", () => {
    expect(
      rankIcons([
        { url: "x", size: 0 },
        { url: "x", size: 64 },
      ]),
    ).toEqual([{ url: "x", size: 64 }]);
  });
});
