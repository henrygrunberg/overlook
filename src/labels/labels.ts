import type { Bookmark } from "../bookmarks/library";
import type { LabelRule } from "../settings/settings";

export type LabelledBookmark = Pick<Bookmark, "hostname" | "isPrivateNetwork">;
export type LabelsOf = (bookmark: LabelledBookmark) => readonly LabelRule[];

/** Linear in the worst case, unlike a backtracking regex. */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starAt = -1;
  let resumeAt = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      starAt = p++;
      resumeAt = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (starAt >= 0) {
      p = starAt + 1;
      t = ++resumeAt;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** "*.acme.com" matches any subdomain of acme.com (and acme.com itself), "10.*" any 10.x host. */
export function hostMatcher(pattern: string): (host: string) => boolean {
  const glob = pattern.toLowerCase().replace(/\*+/g, "*");
  const apex = glob.startsWith("*.") ? glob.slice(2) : null;
  if (apex !== null && !apex.includes("*")) {
    const subdomainSuffix = `.${apex}`;
    return (host) => host === apex || host.endsWith(subdomainSuffix);
  }
  return (host) => (apex !== null && wildcardMatch(apex, host)) || wildcardMatch(glob, host);
}

export function compileLabels(rules: readonly LabelRule[]): LabelsOf {
  const compiled = rules.map((rule) => {
    const exact = new Set(rule.hosts.filter((host) => !host.includes("*")));
    const wildcards = rule.hosts.filter((host) => host.includes("*")).map(hostMatcher);
    const matches = (host: string) => exact.has(host) || wildcards.some((matcher) => matcher(host));
    return { rule, matches };
  });
  const labelsOf = (hostname: string, isPrivateNetwork: boolean) => {
    const bare = hostname.replace(/^www\./, "");
    return compiled
      .filter(
        ({ rule, matches }) =>
          (rule.privateNetwork && isPrivateNetwork) || matches(hostname) || matches(bare),
      )
      .map(({ rule }) => rule);
  };
  // Many bookmarks share a host, and every render and reindex asks again for each of them.
  const known = new Map<string, readonly LabelRule[]>();
  return ({ hostname, isPrivateNetwork }) => {
    const key = `${String(isPrivateNetwork)} ${hostname}`;
    let labels = known.get(key);
    if (labels === undefined) {
      labels = labelsOf(hostname, isPrivateNetwork);
      known.set(key, labels);
    }
    return labels;
  };
}
