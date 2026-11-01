import { describe, expect, it } from "vitest";
import type { LabelRule } from "../../../src/settings/settings";
import { compileLabels, hostMatcher } from "../../../src/labels/labels";

const rule = (overrides: Partial<LabelRule>): LabelRule => ({
  id: "x",
  text: "X",
  color: "gray",
  privateNetwork: false,
  hosts: [],
  ...overrides,
});

describe("hostMatcher", () => {
  it.each([
    ["jira.acme.com", "jira.acme.com", true],
    ["jira.acme.com", "wiki.acme.com", false],
    ["*.atlassian.net", "acme.atlassian.net", true],
    ["*.atlassian.net", "atlassian.net", true],
    ["*.atlassian.net", "notatlassian.net", false],
    ["10.*", "10.0.0.5", true],
    ["10.*", "110.0.0.5", false],
    ["10.0.0.*", "10.0.0.20", true],
    ["*.acme.com", "jira.eu.acme.com", true],
    ["*.acme.com", "acme.com.evil.example", false],
    ["*-staging.acme.com", "api-staging.acme.com", true],
    ["jira.*.com", "jira.acme.com", true],
    ["**.acme.com", "acme.com", true],
    ["*.acme.*", "acme.com", true],
    ["*.acme.*", "jira.acme.com", true],
    ["*.acme.*", "notacme.com", false],
    ["a*****b", "axxb", true],
  ])("%s matches %s: %s", (pattern, host, expected) => {
    expect(hostMatcher(pattern)(host)).toBe(expected);
  });

  it("treats regular-expression characters literally", () => {
    expect(hostMatcher("a+b.com")("aab.com")).toBe(false);
    expect(hostMatcher("a.b")("axb")).toBe(false);
  });

  it("stays fast on many wildcards against a long host that doesn't match", () => {
    const host = `${"a".repeat(240)}.example`;
    const started = performance.now();
    expect(hostMatcher("*a*a*a*a*a*a*b")(host)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("compileLabels", () => {
  const vpn = rule({ id: "vpn", text: "VPN", privateNetwork: true });
  const work = rule({
    id: "work",
    text: "Work",
    hosts: ["*.acme.com", "grafana.internal.example"],
  });
  const labelsOf = compileLabels([vpn, work]);

  it("labels private-network hosts", () => {
    expect(labelsOf({ hostname: "10.0.0.20", isPrivateNetwork: true })).toEqual([vpn]);
  });

  it("labels hosts that match a pattern, ignoring www", () => {
    expect(labelsOf({ hostname: "www.acme.com", isPrivateNetwork: false })).toEqual([work]);
    expect(
      compileLabels([work])({ hostname: "www.grafana.internal.example", isPrivateNetwork: false }),
    ).toEqual([work]);
    expect(labelsOf({ hostname: "grafana.internal.example", isPrivateNetwork: false })).toEqual([
      work,
    ]);
  });

  it("can apply several labels, in rule order", () => {
    expect(labelsOf({ hostname: "nas.acme.com", isPrivateNetwork: true })).toEqual([vpn, work]);
  });

  it("answers the same host the same way, private or not", () => {
    expect(labelsOf({ hostname: "nas.acme.com", isPrivateNetwork: false })).toEqual([work]);
    expect(labelsOf({ hostname: "nas.acme.com", isPrivateNetwork: true })).toEqual([vpn, work]);
    expect(labelsOf({ hostname: "nas.acme.com", isPrivateNetwork: false })).toEqual([work]);
  });

  it("applies nothing to other hosts", () => {
    expect(labelsOf({ hostname: "github.com", isPrivateNetwork: false })).toEqual([]);
  });
});
