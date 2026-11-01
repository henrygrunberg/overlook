import { beforeEach, describe, expect, it, vi } from "vitest";

type Database = typeof import("../../../src/storage/database");

class FakeRequest extends EventTarget {
  result: unknown;
  error: DOMException | null = null;

  succeedSoon(result?: unknown): this {
    queueMicrotask(() => {
      this.result = result;
      this.dispatchEvent(new Event("success"));
    });
    return this;
  }

  failSoon(error: DOMException): this {
    queueMicrotask(() => {
      this.error = error;
      this.dispatchEvent(new Event("error"));
    });
    return this;
  }
}

class FakeTransaction extends EventTarget {
  error: DOMException | null = null;
  readonly deleted: string[] = [];

  objectStore() {
    return {
      get: () => new FakeRequest().succeedSoon(),
      getAllKeys: () => new FakeRequest().succeedSoon(storedKeys),
      put: () => new FakeRequest().succeedSoon(),
      delete: (key: string) => {
        this.deleted.push(key);
        return new FakeRequest().succeedSoon();
      },
    };
  }

  finish(outcome: "complete" | "abort"): void {
    if (outcome === "abort") this.error = new DOMException("Quota exceeded", "QuotaExceededError");
    this.dispatchEvent(new Event(outcome));
  }
}

class FakeDatabase extends EventTarget {
  closed = false;
  readonly transactions: FakeTransaction[] = [];

  transaction(): FakeTransaction {
    const transaction = new FakeTransaction();
    this.transactions.push(transaction);
    return transaction;
  }

  close(): void {
    this.closed = true;
  }
}

let storedKeys: IDBValidKey[] = [];
const opened: FakeDatabase[] = [];
const open = vi.fn(() => {
  const fake = new FakeDatabase();
  opened.push(fake);
  return new FakeRequest().succeedSoon(fake);
});
let database: Database;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const latestTransaction = () => opened.at(-1)?.transactions.at(-1);

beforeEach(async () => {
  opened.length = 0;
  open.mockClear();
  vi.stubGlobal("indexedDB", { open });
  vi.resetModules();
  database = await import("../../../src/storage/database");
});

describe("database writes", () => {
  it("resolve only once the transaction has committed", async () => {
    let saved = false;
    const writing = database.putRecord("files", new Blob(), "background").then(() => {
      saved = true;
    });
    await flush();
    expect(saved).toBe(false);

    latestTransaction()?.finish("complete");
    await writing;
    expect(saved).toBe(true);
  });

  it("fail when the commit aborts after the request succeeded", async () => {
    const writing = database.putRecord("files", new Blob(), "background");
    await flush();
    latestTransaction()?.finish("abort");
    await expect(writing).rejects.toThrow("Quota exceeded");
  });

  it("delete many records in one transaction, and none without a transaction", async () => {
    await database.deleteRecords("icons", []);
    expect(opened).toHaveLength(0);

    const deleting = database.deleteRecords("icons", [
      "https://a.example.com",
      "https://b.example.com",
    ]);
    await flush();
    latestTransaction()?.finish("complete");
    await deleting;
    expect(opened[0]?.transactions).toHaveLength(1);
    expect(latestTransaction()?.deleted).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });
});

describe("database reads", () => {
  it("list a store's keys, leaving out any that aren't text", async () => {
    storedKeys = ["https://a.example.com", 7, ["https://b.example.com"], "https://c.example.com"];
    expect(await database.getAllKeys("icons")).toEqual([
      "https://a.example.com",
      "https://c.example.com",
    ]);
  });
});

describe("database connection", () => {
  it("reopens after the browser closes it", async () => {
    await database.getRecord("icons", "https://a.example.com");
    opened[0]?.dispatchEvent(new Event("close"));
    await database.getRecord("icons", "https://a.example.com");
    expect(opened).toHaveLength(2);
  });

  it("lets go when a newer version needs to upgrade, and reopens on the next use", async () => {
    await database.getRecord("icons", "https://a.example.com");
    opened[0]?.dispatchEvent(new Event("versionchange"));
    expect(opened[0]?.closed).toBe(true);

    await database.getRecord("icons", "https://a.example.com");
    expect(opened).toHaveLength(2);
  });

  it("tries to open again on the next use after opening failed", async () => {
    open.mockImplementationOnce(() =>
      new FakeRequest().failSoon(new DOMException("Disk is full", "UnknownError")),
    );
    await expect(database.getRecord("icons", "https://a.example.com")).rejects.toThrow(
      "Disk is full",
    );

    await expect(database.getRecord("icons", "https://a.example.com")).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("keeps one connection while it stays open", async () => {
    await database.getRecord("icons", "https://a.example.com");
    await database.getRecord("icons", "https://b.example.com");
    expect(opened).toHaveLength(1);
  });
});
