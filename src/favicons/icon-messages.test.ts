import { describe, expect, it } from "vitest";
import { isIconMessage, MAX_MESSAGE_URLS } from "./icon-messages";

const PAGE_URL = "https://a.example.com";

describe("isIconMessage", () => {
  it.each(["ensure-icons", "refresh-icons"])("accepts a %s message", (type) => {
    expect(isIconMessage({ type, urls: [PAGE_URL] })).toBe(true);
  });

  it.each([
    ["null", null],
    ["an unknown type", { type: "delete-everything", urls: [] }],
    ["URLs that aren't a list", { type: "ensure-icons", urls: PAGE_URL }],
    ["a URL that isn't text", { type: "ensure-icons", urls: [7] }],
    ["too many URLs", { type: "ensure-icons", urls: Array(MAX_MESSAGE_URLS + 1).fill(PAGE_URL) }],
    ["an overlong URL", { type: "ensure-icons", urls: [`${PAGE_URL}/${"x".repeat(9000)}`] }],
  ])("rejects %s", (_label, message) => {
    expect(isIconMessage(message)).toBe(false);
  });
});
