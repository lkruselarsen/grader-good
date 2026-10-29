import type { Lab2TileBlend } from "@/lib/lab2/types";
import { CLOUD_ALGORITHM_CODES } from "./types";

/** Unambiguous characters (no 0/O, 1/I/L) so names survive being typed in by hand. */
const SLUG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const CLOUD_SLUG_LENGTH = 10;
const NAME_SLUG_CHARS = 5;

export function randomCloudSlug(length = CLOUD_SLUG_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return out;
}

/** e.g. GG-K7Q2M-07-5050, or GG-K7Q2M-07-5050-E1 for the first re-edit. */
export function cloudOutputName(
  slug: string,
  idx: number,
  algorithm: Lab2TileBlend,
  version = 0
): string {
  const base = `GG-${slug.slice(0, NAME_SLUG_CHARS).toUpperCase()}-${String(idx).padStart(2, "0")}-${CLOUD_ALGORITHM_CODES[algorithm]}`;
  return version > 0 ? `${base}-E${version}` : base;
}

/** Normalises user input for name lookup: trims, drops .png, uppercases. */
export function normalizeCloudOutputName(input: string): string {
  return input.trim().replace(/\.png$/i, "").toUpperCase();
}
