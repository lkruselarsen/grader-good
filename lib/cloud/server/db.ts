import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** Service-role client for cloud routes and Trigger.dev tasks. */
export function cloudSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

export async function downloadObject(
  bucket: string,
  path: string
): Promise<Buffer> {
  const { data, error } = await cloudSupabase().storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(`Download ${bucket}/${path} failed: ${error?.message ?? "no data"}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

export async function uploadObject(
  bucket: string,
  path: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const { error } = await cloudSupabase()
    .storage.from(bucket)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`Upload ${bucket}/${path} failed: ${error.message}`);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
