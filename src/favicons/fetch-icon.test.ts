import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverIcons, fetchBestIcon, isPermittedIconUrl, normalizeIcon } from "./fetch-icon";

const SITE = "https://example.example.com";
const HTML = { "content-type": "text/html" };
const PNG = { "content-type": "image/png" };

describe("isPermittedIconUrl", () => {
  it.each([
    ["the site itself", `${SITE}/favicon.png`, true],
    ["a public CDN", "https://cdn.example.net/icon.png", true],
    [
      "a public host over http, whose name could resolve to the LAN",
      "http://cdn.example.net/",
      false,
    ],
    ["a router on the LAN", "http://192.168.1.1/reboot", false],
    ["the user's own machine", "http://127.0.0.1:8080/admin", false],
    ["IPv6 loopback", "http://[::1]/", false],
    ["a .local device", "http://printer.local/", false],
    ["localhost with a trailing dot", "http://localhost./a", false],
    ["a .local device with a trailing dot", "http://printer.local./", false],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/", false],
    ["an IPv4-mapped router", "http://[::ffff:192.168.1.1]/", false],
    ["a single-label intranet name", "http://router/reboot", false],
    ["the 0.0.0.0/8 block", "http://0.1.2.3/", false],
    ["a non-web scheme", "file:///etc/passwd", false],
    ["garbage", "not a url", false],
  ])("allows %s: %s → %s", (_label, url, expected) => {
    expect(isPermittedIconUrl(url, SITE)).toBe(expected);
  });

  it("lets an intranet site use its own icons", () => {
    expect(isPermittedIconUrl("http://10.0.0.20:3000/logo.png", "http://10.0.0.20:3000")).toBe(
      true,
    );
  });

  it("lets a site served over http use its own icons over http", () => {
    expect(isPermittedIconUrl("http://example.com/logo.png", "http://example.com")).toBe(true);
  });

  it("lets an intranet site use icons from a public host over http", () => {
    expect(isPermittedIconUrl("http://cdn.example.net/logo.png", "http://10.0.0.20:3000")).toBe(
      true,
    );
  });
});

function respond(body: BodyInit | null, headers: HeadersInit = {}, finalUrl?: string): Response {
  const response = new Response(body, { headers });
  if (finalUrl) Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

function fakeSite(routes: Record<string, Response | "offline">) {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(`${init?.redirect ?? "follow"} ${url}`);
    const route = routes[url];
    if (route === "offline") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve(route ?? new Response(null, { status: 404 }));
  };
  return { fetchImpl, requested };
}

// Enough of a PNG for its declared size to be read; the decoder itself is stubbed.
function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const header = new DataView(bytes.buffer);
  header.setUint32(16, width);
  header.setUint32(20, height);
  return bytes;
}

const candidateUrls = async (origin: string, fetchImpl: typeof fetch) => {
  const candidates = await discoverIcons(origin, fetchImpl);
  return candidates === "unreachable" ? candidates : candidates.map((candidate) => candidate.url);
};

interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly alphaAt?: (x: number, y: number) => number;
}

function stubDecoder(
  { width, height, alphaAt = () => 255 }: DecodedImage = { width: 64, height: 64 },
) {
  const close = vi.fn();
  const decode = vi.fn(() => Promise.resolve({ width, height, close }));
  const createCanvas = vi.fn();
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(readonly width: number) {
        createCanvas();
      }
      getContext() {
        return {
          canvas: this,
          drawImage: vi.fn(),
          getImageData: (_x: number, _y: number, columns: number, rows: number) => {
            const data = new Uint8ClampedArray(columns * rows * 4);
            for (let y = 0; y < rows; y++) {
              for (let x = 0; x < columns; x++) data[(y * columns + x) * 4 + 3] = alphaAt(x, y);
            }
            return { data };
          },
        };
      }
      convertToBlob() {
        return Promise.resolve(new Blob(["png"]));
      }
    },
  );
  return { decode, close, createCanvas };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discoverIcons", () => {
  it("never fetches private-network icon URLs declared by a public page", async () => {
    const { fetchImpl, requested } = fakeSite({
      [`${SITE}/`]: respond(
        `<head>
          <link rel="apple-touch-icon" href="http://192.168.1.1/cgi-bin/reboot">
          <link rel="manifest" href="http://10.0.0.1/manifest.json">
          <link rel="icon" sizes="64x64" href="https://cdn.example.net/icon.png">
        </head>`,
        HTML,
      ),
    });

    expect(await candidateUrls(SITE, fetchImpl)).toEqual([
      `${SITE}/apple-touch-icon.png`,
      "https://cdn.example.net/icon.png",
      `${SITE}/favicon.ico`,
    ]);
    expect(requested).toEqual([`follow ${SITE}/`]);
  });

  it("sends no cookies or referrer", async () => {
    let init: RequestInit | undefined;
    await discoverIcons(SITE, (_input, requestInit) => {
      init = requestInit;
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("gives up on a site when neither its page nor its favicon gets a response", async () => {
    const { fetchImpl, requested } = fakeSite({
      [`${SITE}/`]: "offline",
      [`${SITE}/favicon.ico`]: "offline",
    });
    expect(await fetchBestIcon(SITE, fetchImpl)).toBe("unreachable");
    expect(requested).toEqual([`follow ${SITE}/`, `follow ${SITE}/favicon.ico`]);
  });

  it("still tries the usual icon paths when the page never answers but the host does", async () => {
    const { fetchImpl, requested } = fakeSite({ [`${SITE}/`]: "offline" });
    expect(await fetchBestIcon(SITE, fetchImpl)).toBe("missing");
    expect(requested).toEqual([
      `follow ${SITE}/`,
      `follow ${SITE}/favicon.ico`,
      `follow ${SITE}/apple-touch-icon.png`,
      `follow ${SITE}/favicon.ico`,
    ]);
  });

  it("still tries the usual icon paths when the page answers with an error", async () => {
    const { fetchImpl, requested } = fakeSite({
      [`${SITE}/`]: new Response("Server error", { status: 500, headers: HTML }),
    });
    expect(await fetchBestIcon(SITE, fetchImpl)).toBe("missing");
    expect(requested).toEqual([
      `follow ${SITE}/`,
      `follow ${SITE}/apple-touch-icon.png`,
      `follow ${SITE}/favicon.ico`,
    ]);
  });

  it("reads the head of a page that declares a bigger size than allowed", async () => {
    const { fetchImpl } = fakeSite({
      [`${SITE}/`]: respond('<link rel="icon" href="https://cdn.example.net/icon.png">', {
        ...HTML,
        "content-length": String(512 * 1024 + 1),
      }),
    });
    expect(await candidateUrls(SITE, fetchImpl)).toContain("https://cdn.example.net/icon.png");
  });

  it("reads a page only up to the size limit", async () => {
    const link = (name: string) => `<link rel="icon" href="https://cdn.example.net/${name}.png">`;
    const { fetchImpl } = fakeSite({
      [`${SITE}/`]: respond(link("early") + " ".repeat(512 * 1024) + link("late"), HTML),
    });
    const urls = await candidateUrls(SITE, fetchImpl);
    expect(urls).toContain("https://cdn.example.net/early.png");
    expect(urls).not.toContain("https://cdn.example.net/late.png");
  });

  it("stops downloading the page once its head ends", async () => {
    const encoder = new TextEncoder();
    let chunksRead = 0;
    let cancelled = false;
    const endlessPage = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead++;
        controller.enqueue(encoder.encode(chunksRead === 1 ? "<html><head></he" : "ad><body>"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetchImpl } = fakeSite({ [`${SITE}/`]: respond(endlessPage, HTML) });
    await discoverIcons(SITE, fetchImpl);
    expect(cancelled).toBe(true);
    expect(chunksRead).toBeLessThan(5);
  });

  it("keeps reading the head past a </header> tag", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "<html><head><header>Acme</header>",
      '<link rel="icon" href="https://cdn.example.net/icon.png"></head>',
    ];
    const page = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    });
    const { fetchImpl } = fakeSite({ [`${SITE}/`]: respond(page, HTML) });
    expect(await candidateUrls(SITE, fetchImpl)).toContain("https://cdn.example.net/icon.png");
  });

  it("cancels the body of a response it doesn't use", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const { fetchImpl } = fakeSite({ [`${SITE}/`]: new Response(body, { status: 404 }) });
    await discoverIcons(SITE, fetchImpl);
    expect(cancelled).toBe(true);
  });

  it("moves on when an unused body fails to cancel", async () => {
    const body = new ReadableStream({
      cancel() {
        throw new Error("connection reset");
      },
    });
    const { fetchImpl } = fakeSite({ [`${SITE}/`]: new Response(body, { status: 404 }) });
    expect(await candidateUrls(SITE, fetchImpl)).toEqual([
      `${SITE}/apple-touch-icon.png`,
      `${SITE}/favicon.ico`,
    ]);
  });

  it("fetches a public site's icons and manifest from other hosts only over https", async () => {
    const { fetchImpl, requested } = fakeSite({
      [`${SITE}/`]: respond(
        `<link rel="manifest" href="http://cdn.example.net/manifest.json">
        <link rel="icon" href="http://cdn.example.net/icon.png">`,
        HTML,
      ),
    });
    expect(await candidateUrls(SITE, fetchImpl)).toEqual([
      `${SITE}/apple-touch-icon.png`,
      `${SITE}/favicon.ico`,
    ]);
    expect(requested).toEqual([`follow ${SITE}/`]);
  });

  it("ignores a public site's page when it redirects to a private host", async () => {
    const { fetchImpl } = fakeSite({
      [`${SITE}/`]: respond(
        '<link rel="icon" href="https://cdn.example.net/icon.png">',
        HTML,
        "http://192.168.1.1/",
      ),
    });
    expect(await candidateUrls(SITE, fetchImpl)).toEqual([
      `${SITE}/apple-touch-icon.png`,
      `${SITE}/favicon.ico`,
    ]);
  });

  it("ignores the icons of a login page the site redirects to", async () => {
    const { fetchImpl, requested } = fakeSite({
      [`${SITE}/`]: respond(
        `<link rel="apple-touch-icon" sizes="180x180" href="/touch-icon.png">
        <link rel="manifest" href="/manifest.json">`,
        HTML,
        "https://login.example.net/sso?app=wiki",
      ),
    });
    expect(await candidateUrls(SITE, fetchImpl)).toEqual([
      `${SITE}/apple-touch-icon.png`,
      `${SITE}/favicon.ico`,
    ]);
    expect(requested).toEqual([`follow ${SITE}/`]);
  });

  it("keeps the icons of a page the site redirects to on its www host", async () => {
    const { fetchImpl } = fakeSite({
      [`${SITE}/`]: respond(
        '<link rel="icon" sizes="192x192" href="/icon.png">',
        HTML,
        "https://www.example.example.com/start",
      ),
    });
    expect(await candidateUrls(SITE, fetchImpl)).toContain(
      "https://www.example.example.com/icon.png",
    );
  });

  it("resolves manifest icons against the manifest's address after redirects", async () => {
    const { fetchImpl } = fakeSite({
      [`${SITE}/`]: respond('<link rel="manifest" href="/manifest.json">', HTML),
      [`${SITE}/manifest.json`]: respond(
        JSON.stringify({ icons: [{ src: "icons/192.png", sizes: "192x192" }] }),
        { "content-type": "application/manifest+json" },
        `${SITE}/static/site.webmanifest`,
      ),
    });
    expect(await candidateUrls(SITE, fetchImpl)).toContain(`${SITE}/static/icons/192.png`);
  });
});

describe("fetchBestIcon", () => {
  it("lets only the site's own URLs follow redirects", async () => {
    const { fetchImpl, requested } = fakeSite({
      [`${SITE}/`]: respond('<link rel="icon" href="https://cdn.example.net/icon.png">', HTML),
    });
    await fetchBestIcon(SITE, fetchImpl);
    expect(requested).toEqual([
      `follow ${SITE}/`,
      `follow ${SITE}/apple-touch-icon.png`,
      "error https://cdn.example.net/icon.png",
      `follow ${SITE}/favicon.ico`,
    ]);
  });

  it("doesn't use an icon a public site redirects to a private host", async () => {
    const { decode } = stubDecoder();
    const { fetchImpl } = fakeSite({
      [`${SITE}/favicon.ico`]: respond("png", PNG, "http://10.0.0.1/favicon.png"),
    });
    expect(await fetchBestIcon(SITE, fetchImpl)).toBe("missing");
    expect(decode).not.toHaveBeenCalled();
  });

  it("lets an intranet site redirect to another private host", async () => {
    const intranet = "http://10.0.0.20:3000";
    const { decode } = stubDecoder();
    const { fetchImpl } = fakeSite({
      [`${intranet}/favicon.ico`]: respond(pngHeader(64, 64), PNG, "http://10.0.0.21/favicon.png"),
    });
    expect(await fetchBestIcon(intranet, fetchImpl)).not.toBe("missing");
    expect(decode).toHaveBeenCalledOnce();
  });

  it("skips an image bigger than allowed without decoding it", async () => {
    const { decode } = stubDecoder();
    const { fetchImpl } = fakeSite({
      [`${SITE}/favicon.ico`]: respond(new Uint8Array(2 * 1024 * 1024 + 1), PNG),
    });
    expect(await fetchBestIcon(SITE, fetchImpl)).toBe("missing");
    expect(decode).not.toHaveBeenCalled();
  });
});

describe("normalizeIcon", () => {
  const bytes = pngHeader(64, 64);

  it("accepts images up to 4096 pixels across", async () => {
    stubDecoder({ width: 4096, height: 4096 });
    expect(await normalizeIcon(pngHeader(4096, 4096), "image/png")).toMatchObject({
      sourceSize: 4096,
    });
  });

  it.each([
    ["declares more than 4096 pixels across", pngHeader(16000, 16000)],
    ["is in a format whose size it can't read", new Uint8Array([1, 2, 3])],
  ])("skips an image that %s without decoding it", async (_label, image) => {
    const { decode } = stubDecoder();
    expect(await normalizeIcon(image, "image/png")).toBeNull();
    expect(decode).not.toHaveBeenCalled();
  });

  it.each([
    ["too large", { width: 4097, height: 64 }],
    ["too small", { width: 31, height: 64 }],
  ])("rejects an image that decodes %s, and frees it", async (_label, size) => {
    const { close, createCanvas } = stubDecoder(size);
    expect(await normalizeIcon(bytes, "image/png")).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it("lets an icon with opaque corners fill the tile", async () => {
    stubDecoder({ width: 64, height: 64 });
    expect(await normalizeIcon(bytes, "image/png")).toMatchObject({ fullBleed: true });
  });

  it.each([
    ["top left", (x: number, y: number) => x < 64 && y < 64],
    ["top right", (x: number, y: number) => x >= 64 && y < 64],
    ["bottom left", (x: number, y: number) => x < 64 && y >= 64],
    ["bottom right", (x: number, y: number) => x >= 64 && y >= 64],
  ])("centres an icon whose %s corner is transparent", async (_corner, isTransparent) => {
    stubDecoder({ width: 64, height: 64, alphaAt: (x, y) => (isTransparent(x, y) ? 0 : 255) });
    expect(await normalizeIcon(bytes, "image/png")).toMatchObject({ fullBleed: false });
  });
});
