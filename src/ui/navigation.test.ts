import { describe, expect, it } from "vitest";
import { shortcutModifier } from "./navigation";

describe("shortcutModifier", () => {
  it.each([
    ["MacIntel", "⌘"],
    ["iPad", "⌘"],
    ["Win32", "Ctrl"],
    ["Linux x86_64", "Ctrl"],
  ])("on %s is %s", (platform, modifier) => {
    expect(shortcutModifier(platform)).toBe(modifier);
  });
});
