"use client";

/**
 * Phase 2 (local): bulk review from a folder on this device — no server upload.
 * Uses File System Access API when available (Chromium). See inline notes for Phase 3.
 */

import React, { useCallback, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const MAX_FILES = 30;

type FileSystemDirectoryHandleLike = {
  entries: () => AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
};

export default function BulkLocalPage() {
  const [paths, setPaths] = useState<string[]>([]);
  const [note, setNote] = useState("");

  const pickFolder = useCallback(async () => {
    setNote("");
    const w = window as Window &
      typeof globalThis & {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandleLike>;
      };
    if (typeof w.showDirectoryPicker !== "function") {
      setNote(
        "Directory picking needs a Chromium-based browser (or use file input on Lab2). Safari/Firefox: select multiple files instead (stub)."
      );
      return;
    }
    try {
      const dir = await w.showDirectoryPicker();
      const names: string[] = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "file") continue;
        const lower = name.toLowerCase();
        if (
          lower.endsWith(".dng") ||
          lower.endsWith(".cr2") ||
          lower.endsWith(".nef") ||
          lower.endsWith(".arw")
        ) {
          names.push(name);
        }
        if (names.length >= MAX_FILES) break;
      }
      names.sort();
      setPaths(names);
      setNote(
        names.length === 0
          ? "No RAW files found in that folder (checked .dng, .cr2, .nef, .arw)."
          : `Found ${names.length} file(s). Phase 2: wire each handle to Lab2 processing + gallery; Phase 3: hosted upload + share link.`
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="max-w-xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">Bulk (local folder)</h1>
          <Link href="/lab2" className="text-sm text-amber-400/90 hover:underline">
            Lab 2
          </Link>
        </div>
        <p className="text-sm text-zinc-400">
          Experimental: choose a folder containing up to {MAX_FILES} RAW files. This page only lists
          names for now. Next step is decoding + Model 2 match thumbnails and opening each in{" "}
          <Link href="/lab2" className="text-amber-400/90 underline">
            /lab2
          </Link>{" "}
          without uploading bytes off-device.
        </p>
        <Button type="button" className="min-h-11" onClick={pickFolder}>
          Choose folder…
        </Button>
        {note ? <p className="text-sm text-zinc-300">{note}</p> : null}
        {paths.length > 0 ? (
          <ul className="text-sm font-mono text-zinc-400 list-disc pl-5 space-y-1">
            {paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
