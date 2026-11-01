import { buildLibrary } from "../bookmarks/library";
import { isPrivateOrigin } from "../private-network";
import { iconOrigins } from "./icon-store";

// Above the static rules in private-rules.json, which block every private host for the
// extension's own requests: the user's own intranet sites still get their icons.
const ALLOW_PRIORITY = 2;

const allowedHost = (rule: chrome.declarativeNetRequest.Rule) =>
  rule.condition.requestDomains?.[0] ?? "";

let updating = Promise.resolve();

async function replaceAllowRules(hosts: ReadonlySet<string>): Promise<void> {
  const { declarativeNetRequest } = chrome;
  const rules = await declarativeNetRequest.getDynamicRules();
  const present = new Set(rules.map(allowedHost));
  let nextId = rules.reduce((highest, rule) => Math.max(highest, rule.id), 0) + 1;
  const removeRuleIds = rules
    .filter((rule) => !hosts.has(allowedHost(rule)))
    .map((rule) => rule.id);
  // By host rather than origin, so a site that moves to https or another port still answers.
  const addRules = [...hosts]
    .filter((host) => !present.has(host))
    .map((host) => ({
      id: nextId++,
      priority: ALLOW_PRIORITY,
      action: { type: "allow" as const },
      condition: { requestDomains: [host], initiatorDomains: [chrome.runtime.id] },
    }));
  if (removeRuleIds.length > 0 || addRules.length > 0) {
    await declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
}

function setAllowedHosts(hosts: ReadonlySet<string>): Promise<void> {
  // Overlapping updates would each add the same new rules, which Chrome rejects.
  updating = updating.catch(() => undefined).then(() => replaceAllowRules(hosts));
  return updating;
}

/** Lets the extension reach the private-network sites among the user's bookmarks. */
export async function allowBookmarkedPrivateSites(): Promise<void> {
  const { bookmarks } = buildLibrary(await chrome.bookmarks.getTree());
  const origins = [...iconOrigins(bookmarks.map((bookmark) => bookmark.url))];
  await setAllowedHosts(
    new Set(origins.filter(isPrivateOrigin).map((origin) => new URL(origin).hostname)),
  );
}

export function blockPrivateSites(): Promise<void> {
  return setAllowedHosts(new Set());
}
