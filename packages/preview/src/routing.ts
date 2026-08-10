/**
 * Addressing a preview from outside the host.
 *
 * A preview is served **on its own subdomain** — `<token>.preview.von.app` —
 * not on a path prefix under the control plane. That is not cosmetic. Metro
 * serves an index that references root-absolute paths (`/index.bundle`,
 * `/node_modules/...`, the HMR socket), so a prefix like `/p/<token>/` breaks
 * every one of them and no amount of `<base href>` fixes root-absolute URLs.
 * Giving each session an origin means the app is served exactly as it would be
 * on its own, and the proxy is a pure pass-through.
 *
 * It also gets the security boundary right for free: separate origins mean one
 * customer's previewed code cannot read another's, and neither can reach the
 * control plane's origin.
 */

/**
 * Extract a session token from a Host header.
 *
 * Returns null for anything that is not exactly one label in front of the
 * preview host — `preview.von.app` itself, a two-label prefix, a different
 * domain that merely ends with the same characters.
 */
export function tokenFromHost(host: string | undefined, previewHost: string): string | null {
  if (!host || !previewHost) return null;

  // Host carries the port; the routing decision never should.
  const name = host.split(":")[0]!.toLowerCase().replace(/\.$/, "");
  const base = previewHost.split(":")[0]!.toLowerCase().replace(/\.$/, "");

  const suffix = `.${base}`;
  if (!name.endsWith(suffix)) return null;

  const label = name.slice(0, -suffix.length);
  // Exactly one label, and a plausible token. `a.b.preview.von.app` is not a
  // session address, and treating it as one would let a wildcard certificate's
  // extra labels smuggle in something unexpected.
  if (!/^[a-z0-9]{8,128}$/.test(label)) return null;
  return label;
}

/** The URL handed to the client for a session, when a preview host is set. */
export function previewUrl(previewHost: string, token: string, scheme = "https"): string {
  return `${scheme}://${token}.${previewHost}/`;
}
