// Unspecified, loopback, RFC 1918, link-local and carrier-grade NAT addresses.
const PRIVATE_IPV4 =
  /^(?:(?:0|10|127)\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01])|169\.254|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d+\.\d+$/;
// Unspecified, loopback, unique-local and link-local IPv6 addresses.
const PRIVATE_IPV6 = /^\[(?:::1?|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*)\]$/;
// IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d) forms reach the
// IPv4 host, and the URL parser writes their last 32 bits as two hex groups.
const EMBEDDED_IPV4 = /^\[::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;
const LOCAL_DOMAIN = /\.(?:localhost|local|lan|internal|home\.arpa)$/;
// Names without a dot (localhost, router, jira) resolve through the LAN's own DNS search domains.
const SINGLE_LABEL = /^[^.[]+$/;

function embeddedIpv4(host: string): string | null {
  const [, high, low] = EMBEDDED_IPV4.exec(host) ?? [];
  if (high === undefined || low === undefined) return null;
  const bits = (parseInt(high, 16) << 16) | parseInt(low, 16);
  return [24, 16, 8, 0].map((shift) => (bits >>> shift) & 0xff).join(".");
}

export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return (
    SINGLE_LABEL.test(host) ||
    LOCAL_DOMAIN.test(host) ||
    PRIVATE_IPV6.test(host) ||
    PRIVATE_IPV4.test(embeddedIpv4(host) ?? host)
  );
}

export const isPrivateOrigin = (origin: string) => isPrivateNetworkHost(new URL(origin).hostname);
