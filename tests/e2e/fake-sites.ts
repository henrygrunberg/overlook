import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";

export function solidPng(size: number, rgba: readonly [number, number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill(rgba).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array<Buffer>(size).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface FakeSite {
  readonly html: string;
  readonly files: Readonly<Record<string, Buffer>>;
  /** More HTML pages besides "/". */
  readonly pages?: Readonly<Record<string, string>>;
}

/** A host name the extension treats as public; the test browser resolves it to 127.0.0.1. */
export const PUBLIC_LOOKING_HOST = "public.example.com";

type Respond = (path: string, response: ServerResponse) => void;

function shutDown(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  // Otherwise a kept-alive connection would let the browser keep talking to a "stopped" site.
  server.closeAllConnections();
  return closed;
}

export class FakeSites {
  readonly requests: string[] = [];
  private readonly serversByPort = new Map<string, Server>();

  add(site: FakeSite): Promise<string> {
    return this.listen("127.0.0.1", (path, response) => {
      const page = path === "/" ? site.html : site.pages?.[path];
      if (page !== undefined) {
        response.writeHead(200, { "content-type": "text/html" }).end(page);
        return;
      }
      const file = site.files[path];
      if (file) response.writeHead(200, { "content-type": "image/png" }).end(file);
      else response.writeHead(404).end();
    });
  }

  /** Redirects every path to the same path under `target`, which may have a path of its own. */
  addRedirect(hostname: string, target: string): Promise<string> {
    return this.listen(hostname, (path, response) => {
      response.writeHead(302, { location: new URL(path.slice(1), target).href }).end();
    });
  }

  private async listen(hostname: string, respond: Respond): Promise<string> {
    const server = createServer((request, response) => {
      const path = request.url ?? "/";
      this.requests.push(`${String((server.address() as AddressInfo).port)}${path}`);
      respond(path, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = String((server.address() as AddressInfo).port);
    this.serversByPort.set(port, server);
    return `http://${hostname}:${port}/`;
  }

  async stop(url: string): Promise<void> {
    const { port } = new URL(url);
    const server = this.serversByPort.get(port);
    if (!server) throw new Error(`No fake site is listening on ${url}`);
    this.serversByPort.delete(port);
    await shutDown(server);
  }

  async close(): Promise<void> {
    await Promise.all([...this.serversByPort.values()].map(shutDown));
    this.serversByPort.clear();
  }
}
