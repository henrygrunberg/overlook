import { describe, expect, it } from "vitest";
import { isPrivateNetworkHost, isPrivateOrigin } from "../../src/private-network";

describe("isPrivateNetworkHost", () => {
  it.each([
    "192.168.0.10",
    "10.0.0.8",
    "172.16.4.1",
    "172.31.255.1",
    "localhost",
    "nas.local",
    "0.0.0.0",
    "[::1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "100.64.0.1",
    "app.localhost",
    "localhost.",
    "printer.local.",
    "router",
    "0.1.2.3",
    "[::]",
    "[::ffff:7f00:1]",
    "[::ffff:c0a8:101]",
    "[::7f00:1]",
    "[::ffff:a00:14]",
    "NAS.Local",
  ])("treats %s as private", (host) => {
    expect(isPrivateNetworkHost(host)).toBe(true);
  });

  it.each([
    "172.32.0.1",
    "github.com",
    "8.8.8.8",
    "192.169.1.1",
    "100.128.0.1",
    "[2001:db8::1]",
    "localhost.com",
    "example.com.",
    "[::ffff:808:808]",
  ])("treats %s as public", (host) => {
    expect(isPrivateNetworkHost(host)).toBe(false);
  });
});

describe("isPrivateOrigin", () => {
  it("goes by the origin's host", () => {
    expect(isPrivateOrigin("http://192.168.1.2:8080")).toBe(true);
    expect(isPrivateOrigin("https://docs.example.com")).toBe(false);
  });
});
