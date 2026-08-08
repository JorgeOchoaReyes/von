import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, no i/l/o/u

/**
 * Short, URL-safe, case-insensitive id. Used for tenant/app/build ids that show
 * up in project names, repo names, and slugs — so it must survive being
 * lowercased and read aloud.
 */
export function shortId(length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export const newTenantId = () => `tnt_${shortId(12)}`;
export const newAppId = () => `app_${shortId(12)}`;
export const newBuildId = () => `bld_${shortId(12)}`;
export const newRunId = () => `run_${shortId(16)}`;

/**
 * A DNS/Firebase-safe slug. Firebase project ids must be 6-30 chars, lowercase
 * letters/digits/hyphens, and start with a letter — this is the narrowest of
 * the constraints across Firebase, GitHub repo names, and Expo slugs, so every
 * downstream name is derived from this one function.
 */
export function slugify(input: string, fallback = "app"): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  const withLetter = /^[a-z]/.test(base) ? base : `a-${base}`;
  const trimmed = withLetter.slice(0, 20).replace(/-+$/g, "");
  return trimmed.length >= 3 ? trimmed : fallback;
}
