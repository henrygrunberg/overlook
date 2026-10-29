import { isRecord } from "../validation";

export type IconMessage =
  | { readonly type: "ensure-icons"; readonly urls: readonly string[] }
  | { readonly type: "refresh-icons"; readonly urls: readonly string[] };

// Generous for any real bookmark collection, but bounded.
export const MAX_MESSAGE_URLS = 50_000;
const MAX_URL_LENGTH = 8192;

export function isIconMessage(value: unknown): value is IconMessage {
  if (!isRecord(value)) return false;
  const { type, urls } = value;
  return (
    (type === "ensure-icons" || type === "refresh-icons") &&
    Array.isArray(urls) &&
    urls.length <= MAX_MESSAGE_URLS &&
    urls.every((url) => typeof url === "string" && url.length <= MAX_URL_LENGTH)
  );
}
