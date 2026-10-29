import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconLibrary } from "./icon-library";
import type { IconRecord } from "./icon-store";

const DAY = 86_400_000;

const stored = vi.hoisted((): IconRecord[] => []);
const readIcon = vi.hoisted(() => vi.fn<(origin: string) => Promise<IconRecord | undefined>>());
vi.mock("./icon-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./icon-store")>()),
  readAllIcons: () => Promise.resolve(stored),
  readIcon,
}));

const FRESH = "https://fresh.example.com";

function fakeIconChannel() {
  const listeners: ((event: MessageEvent) => void)[] = [];
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
        listeners.push(listener);
      }
    },
  );
  return (data: unknown) => {
    for (const listener of listeners) listener(new MessageEvent("message", { data }));
  };
}

const sendMessage = vi.fn(() => Promise.resolve());

beforeEach(() => {
  fakeIconChannel();
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  stored.splice(0, stored.length, {
    origin: FRESH,
    status: "ok",
    image: new Blob(["icon"]),
    fullBleed: false,
    fetchedAt: Date.now() - DAY,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sendMessage.mockClear();
  readIcon.mockReset();
});

describe("IconLibrary", () => {
  it("asks the service worker only for sites without a fresh icon, once each", async () => {
    const icons = await IconLibrary.load();
    icons.request([
      "https://fresh.example.com/a",
      "https://new.example.com/a",
      "https://new.example.com/b",
    ]);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: "ensure-icons",
      urls: ["https://new.example.com"],
    });
  });

  it("doesn't wake the service worker when every icon is fresh", async () => {
    const icons = await IconLibrary.load();
    icons.request(["https://fresh.example.com/a"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("asks for every site when downloading again", async () => {
    const icons = await IconLibrary.load();
    icons.request(["https://fresh.example.com/a", "chrome://settings"], true);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: "refresh-icons",
      urls: ["https://fresh.example.com"],
    });
  });

  it("creates an image URL only when an icon is first shown", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:icon");
    const icons = await IconLibrary.load();
    expect(createObjectURL).not.toHaveBeenCalled();

    icons.iconFor("https://fresh.example.com/a");
    expect(icons.iconFor("https://fresh.example.com/b")).toEqual({
      kind: "image",
      src: "blob:icon",
      fullBleed: false,
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("keeps the browser's favicon for a site it never reached, and doesn't ask again yet", async () => {
    const intranet = "https://intranet.example.com";
    stored.push({
      origin: intranet,
      status: "unreachable",
      fetchedAt: Date.now(),
      failedAttempts: 1,
    });
    const icons = await IconLibrary.load();
    expect(icons.iconFor(`${intranet}/wiki`)).toEqual({ kind: "unknown" });
    icons.request([`${intranet}/wiki`]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("shows a letter for a site without a usable icon", async () => {
    stored.push({ origin: "https://none.example.com", status: "missing", fetchedAt: Date.now() });
    const icons = await IconLibrary.load();
    expect(icons.iconFor("https://none.example.com/a")).toEqual({ kind: "none" });
  });

  it("counts only sites whose icon is cached", async () => {
    stored.push({ origin: "https://none.example.com", status: "missing", fetchedAt: Date.now() });
    const icons = await IconLibrary.load();
    expect(icons.hasCachedIcon(FRESH)).toBe(true);
    expect(icons.hasCachedIcon("https://none.example.com")).toBe(false);
    expect(icons.hasCachedIcon("https://new.example.com")).toBe(false);
  });

  it("swaps in an icon another context updated, and frees the old image", async () => {
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:old")
      .mockReturnValueOnce("blob:new");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockReturnValue();
    const broadcast = fakeIconChannel();
    readIcon.mockResolvedValue({
      origin: FRESH,
      status: "ok",
      image: new Blob(["new icon"]),
      fullBleed: true,
      fetchedAt: Date.now(),
    });
    const icons = await IconLibrary.load();
    const onUpdate = vi.fn();
    icons.watch(onUpdate);
    expect(icons.iconFor(`${FRESH}/a`)).toMatchObject({ src: "blob:old" });

    broadcast({ origin: FRESH });
    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledExactlyOnceWith(FRESH);
    });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:old");
    expect(icons.iconFor(`${FRESH}/a`)).toEqual({
      kind: "image",
      src: "blob:new",
      fullBleed: true,
    });
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("shows an icon the service worker saved while the cache was being read", async () => {
    const broadcast = fakeIconChannel();
    readIcon.mockResolvedValue({
      origin: FRESH,
      status: "ok",
      image: new Blob(["new icon"]),
      fullBleed: false,
      fetchedAt: Date.now(),
    });
    const loading = IconLibrary.load();
    broadcast({ origin: FRESH });
    const icons = await loading;
    const onUpdate = vi.fn();
    icons.watch(onUpdate);
    await vi.waitFor(() => {
      expect(onUpdate).toHaveBeenCalledExactlyOnceWith(FRESH);
    });
  });

  it("ignores icon broadcasts without an origin", async () => {
    const broadcast = fakeIconChannel();
    const icons = await IconLibrary.load();
    icons.watch(vi.fn());
    broadcast({ origin: 7 });
    broadcast(null);
    broadcast("https://fresh.example.com");
    expect(readIcon).not.toHaveBeenCalled();
  });
});
