import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

export const CLOUD_KEY_HEADER = "x-cloud-key";

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Returns an error response unless the request carries the CLOUD_ACCESS_KEY passphrase. */
export function requireCloudKey(request: Request): NextResponse | null {
  const expected = process.env.CLOUD_ACCESS_KEY;
  if (!expected) return jsonError("CLOUD_ACCESS_KEY is not configured on the server.", 503);
  const given = request.headers.get(CLOUD_KEY_HEADER) ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return jsonError("Wrong or missing cloud passphrase.", 401);
  }
  return null;
}

export function publicOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) return `${proto}://${forwardedHost}`;
  return new URL(request.url).origin;
}
