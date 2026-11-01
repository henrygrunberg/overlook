import { describe, expect, it, vi } from "vitest";
import {
  discoverIcons,
  fetchBestIcon,
  isPermittedIconUrl,
  normalizeIcon,
} from "../../../src/favicons/fetch-icon";

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
    ["a router on the LAN over https", "https://192.168.1.1/reboot", false],
    ["an IPv4-mapped router over https", "https://[::ffff:192.168.1.1]/", false],
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

  it("keeps an intranet site away from other private hosts", () => {
    expect(isPermittedIconUrl("http://10.0.0.21/logo.png", "http://10.0.0.20:3000")).toBe(false);
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

  it("reads a page full of decoy head ends in linear time", async () => {
    const chunk = new TextEncoder().encode("<a>".repeat(337) + "<!--</head>-->");
    let sent = 0;
    const page = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ * chunk.byteLength > 512 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const { fetchImpl } = fakeSite({ [`${SITE}/`]: respond(page, HTML) });
    const started = performance.now();
    await discoverIcons(SITE, fetchImpl);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("stops soon after a real head end that follows a decoy", async () => {
    const encoder = new TextEncoder();
    let chunksRead = 0;
    let cancelled = false;
    const page = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead++;
        if (chunksRead === 1) {
          controller.enqueue(encoder.encode("<head><!--</head>-->" + "<meta>".repeat(100)));
        } else {
          controller.enqueue(encoder.encode(chunksRead === 2 ? "</head>" : "<p>body</p>"));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetchImpl } = fakeSite({ [`${SITE}/`]: respond(page, HTML) });
    await discoverIcons(SITE, fetchImpl);
    expect(cancelled).toBe(true);
    expect(chunksRead).toBeLessThan(200);
  });

  it("keeps reading past a </head> inside a script", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "<html><head><script>document.write('</head>');</script>",
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

  it("doesn't scan a page that isn't HTML", async () => {
    const { fetchImpl } = fakeSite({
      [`${SITE}/`]: respond('<link rel="icon" href="/custom.png">', {
        "content-type": "text/plain",
      }),
    });
    expect(await candidateUrls(SITE, fetchImpl)).not.toContain(`${SITE}/custom.png`);
  });

  it("ignores a manifest bigger than allowed", async () => {
    const { fetchImpl } = fakeSite({
      [`${SITE}/`]: respond('<link rel="manifest" href="/manifest.json">', HTML),
      [`${SITE}/manifest.json`]: respond(
        JSON.stringify({
          icons: [{ src: "/192.png", sizes: "192x192" }],
          padding: " ".repeat(64 * 1024),
        }),
        { "content-type": "application/manifest+json" },
      ),
    });
    expect(await candidateUrls(SITE, fetchImpl)).not.toContain(`${SITE}/192.png`);
  });

  it("lets only a manifest on the site itself follow redirects", async () => {
    const manifest = (href: string) =>
      fakeSite({ [`${SITE}/`]: respond(`<link rel="manifest" href="${href}">`, HTML) });
    const own = manifest("/manifest.json");
    await discoverIcons(SITE, own.fetchImpl);
    expect(own.requested).toContain(`follow ${SITE}/manifest.json`);

    const elsewhere = manifest("https://cdn.example.net/manifest.json");
    await discoverIcons(SITE, elsewhere.fetchImpl);
    expect(elsewhere.requested).toContain("error https://cdn.example.net/manifest.json");
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

  it("doesn't use an icon a public site redirects to another host over http", async () => {
    const { decode } = stubDecoder();
    const { fetchImpl } = fakeSite({
      [`${SITE}/favicon.ico`]: respond(pngHeader(64, 64), PNG, "http://lan-alias.example.net/"),
    });
    expect(await fetchBestIcon(SITE, fetchImpl)).toBe("missing");
    expect(decode).not.toHaveBeenCalled();
  });

  it("lets an intranet site redirect to another private host that is bookmarked too", async () => {
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
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    oversized.set(pngHeader(64, 64));
    const { fetchImpl } = fakeSite({ [`${SITE}/favicon.ico`]: respond(oversized, PNG) });
    expect(await fetchBestIcon(SITE, fetchImpl)).toBe("missing");
    expect(decode).not.toHaveBeenCalled();
  });

  it("skips an image whose declared length is over the limit without reading it", async () => {
    const { decode } = stubDecoder();
    const { fetchImpl } = fakeSite({
      [`${SITE}/favicon.ico`]: respond(pngHeader(64, 64), {
        ...PNG,
        "content-length": String(2 * 1024 * 1024 + 1),
      }),
    });
    expect(await fetchBestIcon(SITE, fetchImpl)).toBe("missing");
    expect(decode).not.toHaveBeenCalled();
  });

  it("gives every request a timeout", async () => {
    const signals: unknown[] = [];
    await fetchBestIcon(SITE, (_input, init) => {
      signals.push(init?.signal);
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    expect(signals).not.toHaveLength(0);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("downloads at most six icons", async () => {
    const links = Array.from({ length: 8 }, (_, index) => `<link rel="icon" href="/${index}.png">`);
    const { fetchImpl, requested } = fakeSite({ [`${SITE}/`]: respond(links.join(""), HTML) });
    await fetchBestIcon(SITE, fetchImpl);
    expect(requested.slice(1)).toHaveLength(6);
  });

  it("stops once an icon is big enough", async () => {
    stubDecoder({ width: 96, height: 96 });
    const { fetchImpl, requested } = fakeSite({
      [`${SITE}/apple-touch-icon.png`]: respond(pngHeader(96, 96), PNG),
    });
    await fetchBestIcon(SITE, fetchImpl);
    expect(requested).toEqual([`follow ${SITE}/`, `follow ${SITE}/apple-touch-icon.png`]);
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
