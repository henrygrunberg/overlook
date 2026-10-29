const DATABASE_NAME = "overlook";
const DATABASE_VERSION = 1;

export type StoreName = "icons" | "files";

let connection: Promise<IDBDatabase> | undefined;

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.addEventListener("success", () => {
      resolve(operation.result);
    });
    operation.addEventListener("error", () => {
      reject(operation.error ?? new Error("IndexedDB request failed"));
    });
  });
}

// A write can still fail after its request succeeded (a full disk aborts the commit), so writes
// only count once the transaction completes.
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => {
      resolve();
    });
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new Error("IndexedDB write was aborted"));
    });
  });
}

function forget(database: IDBDatabase): void {
  database.close();
  connection = undefined;
}

function openDatabase(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    opening.addEventListener("upgradeneeded", () => {
      opening.result.createObjectStore("icons", { keyPath: "origin" });
      opening.result.createObjectStore("files");
    });
    opening.addEventListener("success", () => {
      const database = opening.result;
      // The browser closes the connection when site data is cleared, and a newer version of the
      // extension can only upgrade the database once every open tab lets go of it.
      database.addEventListener("close", () => {
        forget(database);
      });
      database.addEventListener("versionchange", () => {
        forget(database);
      });
      resolve(database);
    });
    opening.addEventListener("error", () => {
      connection = undefined;
      reject(opening.error ?? new Error("Cannot open IndexedDB"));
    });
  });
  return connection;
}

async function objectStore(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDatabase()).transaction(name, mode).objectStore(name);
}

export async function getRecord(store: StoreName, key: string): Promise<unknown> {
  return request<unknown>((await objectStore(store, "readonly")).get(key));
}

export async function getAllRecords(store: StoreName): Promise<unknown[]> {
  return request<unknown[]>((await objectStore(store, "readonly")).getAll());
}

export async function getAllKeys(store: StoreName): Promise<string[]> {
  const keys = await request((await objectStore(store, "readonly")).getAllKeys());
  return keys.filter((key) => typeof key === "string");
}

export async function putRecord(store: StoreName, value: unknown, key?: string): Promise<void> {
  const write = (await openDatabase()).transaction(store, "readwrite");
  write.objectStore(store).put(value, key);
  await committed(write);
}

export async function deleteRecords(store: StoreName, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const write = (await openDatabase()).transaction(store, "readwrite");
  for (const key of keys) write.objectStore(store).delete(key);
  await committed(write);
}
