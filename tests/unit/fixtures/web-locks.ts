// happy-dom has no navigator.locks; this one runs each name's callbacks one at a time, in order.
const queues = new Map<string, Promise<unknown>>();

const locks = {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
    const result = (queues.get(name) ?? Promise.resolve()).then(callback);
    queues.set(
      name,
      result.catch(() => undefined),
    );
    return result;
  },
};

Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
