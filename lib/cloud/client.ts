"use client";

import type {
  CloudJobSettings,
  CloudJobView,
  CloudOutputView,
  CloudRenderSettings,
  CloudStorageUsage,
} from "./types";

const KEY_STORAGE = "grader-good:cloud-key";

export function getCloudKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setCloudKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, key.trim());
  } catch {
    /* ignore */
  }
}

/** Returns the saved passphrase, prompting for it once per device. */
export function ensureCloudKey(): string | null {
  const existing = getCloudKey();
  if (existing) return existing;
  const entered = window.prompt("Cloud passphrase (CLOUD_ACCESS_KEY):")?.trim();
  if (!entered) return null;
  setCloudKey(entered);
  return entered;
}

export class CloudApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function cloudFetch<T>(path: string, init: RequestInit = {}, withKey = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (withKey) {
    const key = ensureCloudKey();
    if (!key) throw new CloudApiError("A cloud passphrase is required.", 401);
    headers.set("x-cloud-key", key);
  }
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...init, headers, cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    if (res.status === 401) setCloudKey("");
    throw new CloudApiError(data.error ?? `Request failed (${res.status})`, res.status);
  }
  return data;
}

export type CreatedCloudJob = {
  slug: string;
  url: string;
  uploads: Array<{ id: string; idx: number; name: string; signedUrl: string }>;
};

export function createCloudJob(settings: CloudJobSettings, files: File[]) {
  return cloudFetch<CreatedCloudJob>("/api/cloud/jobs", {
    method: "POST",
    body: JSON.stringify({ settings, files: files.map((f) => ({ name: f.name, size: f.size })) }),
  });
}

/** PUT to a Supabase signed upload URL with progress (fetch has no upload progress). */
export function uploadToSignedUrl(
  signedUrl: string,
  file: File,
  onProgress: (loaded: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl);
    xhr.setRequestHeader("x-upsert", "true");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText.slice(0, 200)}`));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", file);
    xhr.send(form);
  });
}

export function markCloudItemUploaded(itemId: string) {
  return cloudFetch<{ ok: boolean }>(`/api/cloud/items/${itemId}/uploaded`, { method: "POST" });
}

export function fetchCloudJob(slug: string) {
  return cloudFetch<CloudJobView>(`/api/cloud/jobs/${slug}`, {}, false);
}

export function fetchCloudOutput(outputId: string) {
  return cloudFetch<CloudOutputView>(`/api/cloud/outputs/${outputId}`, {}, false);
}

export function findCloudOutputByName(name: string) {
  return cloudFetch<{ outputId: string; name: string; status: string; slug: string | null }>(
    `/api/cloud/outputs/by-name?name=${encodeURIComponent(name)}`
  );
}

export function startCloudEdit(outputId: string) {
  return cloudFetch<{ sessionId: string }>(`/api/cloud/outputs/${outputId}/edit`, { method: "POST" });
}

export type CloudEditSessionView = {
  id: string;
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  output: {
    id: string;
    name: string;
    algorithm: CloudOutputView["algorithm"];
    sampleName: string | null;
    lookParams: CloudRenderSettings["lookParams"];
    finalGrading: CloudRenderSettings["lookParams"]["grading"];
    renderSettings: CloudRenderSettings;
    slug: string | null;
  };
};

export function fetchCloudEditSession(sessionId: string) {
  return cloudFetch<CloudEditSessionView>(`/api/cloud/edit-sessions/${sessionId}`);
}

export function startCloudRender(outputId: string, settings: CloudRenderSettings) {
  return cloudFetch<{ outputId: string; name: string }>(`/api/cloud/outputs/${outputId}/render`, {
    method: "POST",
    body: JSON.stringify(settings),
  });
}

export function fetchCloudStorage() {
  return cloudFetch<CloudStorageUsage>("/api/cloud/storage");
}

export function clearCloudStorage(scope: "dngs" | "exports" | "all") {
  return cloudFetch<{ usage: CloudStorageUsage }>(`/api/cloud/storage?scope=${scope}`, {
    method: "DELETE",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

/** Decodes a gzipped Float32 RGBA preview published by the cloud edit task. */
export async function fetchFloatPreview(
  url: string,
  width: number,
  height: number
): Promise<{ width: number; height: number; data: Float32Array }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Preview download failed (${res.status})`);
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  const data = new Float32Array(buf);
  if (data.length !== width * height * 4) {
    throw new Error("Preview size does not match the edit session.");
  }
  return { width, height, data };
}

/** Fetches PNGs into memory so a later tap can hand them to the share sheet. */
export async function preparePngFiles(items: Array<{ url: string; name: string }>): Promise<File[]> {
  const files: File[] = [];
  for (const item of items) {
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Download of ${item.name} failed (${res.status})`);
    const blob = await res.blob();
    files.push(new File([blob], `${item.name}.png`, { type: "image/png" }));
  }
  return files;
}

export function canShareFiles(files: File[]): boolean {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  return typeof nav.share === "function" && !!nav.canShare?.({ files });
}

/**
 * Saves PNGs to the iPhone photo library through the share sheet ("Save Images"),
 * or downloads them one by one where sharing files is unsupported. Must be
 * called directly from a tap: iOS rejects share() once the gesture has expired.
 */
export async function savePngFiles(files: File[]): Promise<"shared" | "downloaded"> {
  if (canShareFiles(files)) {
    await navigator.share({ files });
    return "shared";
  }
  for (const file of files) {
    const href = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = href;
    a.download = file.name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
    await new Promise((r) => setTimeout(r, 300));
  }
  return "downloaded";
}
