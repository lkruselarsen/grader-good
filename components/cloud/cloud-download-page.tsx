"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Copy, Download, Loader2, Pencil, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CloudApiError,
  canShareFiles,
  fetchCloudJob,
  findCloudOutputByName,
  preparePngFiles,
  savePngFiles,
} from "@/lib/cloud/client";
import type { CloudJobView, CloudOutputView } from "@/lib/cloud/types";
import { TILE_BLEND_SHORT_LABELS, type Lab2TileBlend } from "@/lib/lab2/types";
import { cn } from "@/lib/utils";
import { CloudStorageToast } from "./storage-toast";

const POLL_MS = 5000;
const SAVE_CHUNK = 5;

const noopSubscribe = () => () => {};

function statusLine(job: CloudJobView): string {
  const total = job.items.length;
  const done = job.items.filter((i) => i.status === "done").length;
  const failed = job.items.filter((i) => i.status === "failed").length;
  const waiting = job.items.filter((i) => i.status === "pending").length;
  switch (job.status) {
    case "uploading":
      return `Waiting for uploads (${total - waiting}/${total} uploaded)…`;
    case "processing":
      return `Processing in the cloud: ${done}/${total} photos ready${failed ? `, ${failed} failed` : ""}. This page refreshes on its own.`;
    case "done":
      return `All ${total} photo${total === 1 ? "" : "s"} ready.`;
    case "partial":
      return `${done}/${total} photos ready; ${failed + waiting} could not be processed.`;
    default:
      return "Processing failed for this batch.";
  }
}

function editHref(outputId: string) {
  return `/lab2?cloudOutput=${encodeURIComponent(outputId)}`;
}

export function CloudDownloadPage({ slug }: { slug: string }) {
  const router = useRouter();
  const [job, setJob] = useState<CloudJobView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CloudOutputView | null>(null);
  const [copied, setCopied] = useState(false);
  const [nameQuery, setNameQuery] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const pageUrl = useSyncExternalStore(
    noopSubscribe,
    () => window.location.href,
    () => `/c/${slug}`
  );

  const refresh = useCallback(async () => {
    try {
      setJob(await fetchCloudJob(slug));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active =
    !job ||
    job.status === "uploading" ||
    job.status === "processing" ||
    job.outputs.some((o) => o.status === "pending" || o.status === "processing");
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [active, refresh]);

  const itemsById = useMemo(
    () => new Map((job?.items ?? []).map((i) => [i.id, i])),
    [job]
  );

  const folders = useMemo(() => {
    if (!job) return [] as Array<{ algorithm: Lab2TileBlend; outputs: CloudOutputView[] }>;
    return job.settings.algorithms.map((algorithm) => ({
      algorithm,
      outputs: job.outputs
        .filter((o) => o.algorithm === algorithm)
        .sort((a, b) => {
          const ia = itemsById.get(a.itemId)?.idx ?? 0;
          const ib = itemsById.get(b.itemId)?.idx ?? 0;
          return ia - ib || a.version - b.version;
        }),
    }));
  }, [itemsById, job]);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(pageUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* shown as text below */
    }
  };

  const findByName = async () => {
    setNameError(null);
    setFinding(true);
    try {
      const found = await findCloudOutputByName(nameQuery);
      router.push(editHref(found.outputId));
    } catch (e) {
      setNameError(e instanceof CloudApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setFinding(false);
    }
  };

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 pb-16 md:p-8">
      <CloudStorageToast />
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Your photos</h1>
          <Button asChild variant="ghost" size="sm">
            <Link href="/lab2">Open editor</Link>
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 select-all break-all rounded bg-muted px-2 py-1 text-xs">
            {pageUrl}
          </code>
          <Button type="button" size="sm" variant="outline" onClick={() => void copyUrl()}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {job && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {active && <Loader2 className="size-4 animate-spin" />}
            {statusLine(job)}
          </p>
        )}
        {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      </header>

      <section className="space-y-2 rounded-lg border p-3">
        <p className="text-sm font-medium">Edit a photo by name</p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void findByName();
          }}
        >
          <Input
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder="GG-XXXXX-07-5050"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono"
          />
          <Button type="submit" disabled={!nameQuery.trim() || finding}>
            {finding ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
            Edit
          </Button>
        </form>
        {nameError && <p className="text-xs text-destructive">{nameError}</p>}
      </section>

      {job && folders.length > 0 && (
        <Tabs defaultValue={folders[0]!.algorithm} className="w-full">
          <TabsList>
            {folders.map((f) => (
              <TabsTrigger key={f.algorithm} value={f.algorithm}>
                {TILE_BLEND_SHORT_LABELS[f.algorithm]} (
                {f.outputs.filter((o) => o.status === "done" && o.pngUrl).length})
              </TabsTrigger>
            ))}
          </TabsList>
          {folders.map((f) => (
            <TabsContent key={f.algorithm} value={f.algorithm} className="space-y-4">
              <BulkSave outputs={f.outputs.filter((o) => o.status === "done" && !!o.pngUrl)} />
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {job.items.map((item) =>
                  f.outputs
                    .filter((o) => o.itemId === item.id)
                    .map((o) => (
                      <li key={o.id}>
                        <button
                          type="button"
                          disabled={o.status !== "done" || !o.thumbUrl}
                          onClick={() => setPreview(o)}
                          className="block w-full overflow-hidden rounded-md border bg-muted text-left"
                        >
                          <div className="flex aspect-[3/2] items-center justify-center bg-black/80">
                            {o.thumbUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={o.thumbUrl}
                                alt={o.name}
                                loading="lazy"
                                className="h-full w-full object-contain"
                              />
                            ) : (
                              <span className="flex items-center gap-1 px-2 text-center text-[11px] text-muted-foreground">
                                {(o.status === "pending" || o.status === "processing") && (
                                  <Loader2 className="size-3 animate-spin" />
                                )}
                                {o.status === "failed"
                                  ? "Failed"
                                  : o.status === "done"
                                    ? "Cleared"
                                    : "Processing…"}
                              </span>
                            )}
                          </div>
                          <div className="space-y-0.5 p-2">
                            <p className="truncate font-mono text-[11px]">
                              {o.name}
                              {o.version > 0 ? " (edit)" : ""}
                            </p>
                            <p
                              className={cn(
                                "truncate text-[10px] text-muted-foreground",
                                o.status === "failed" && "text-destructive"
                              )}
                              title={o.error ?? undefined}
                            >
                              {o.status === "failed" ? o.error : item.originalFilename}
                            </p>
                          </div>
                        </button>
                      </li>
                    ))
                )}
                {job.items
                  .filter((item) => !f.outputs.some((o) => o.itemId === item.id))
                  .map((item) => (
                    <li
                      key={`${f.algorithm}-${item.id}`}
                      className="flex aspect-[3/2] flex-col items-center justify-center gap-1 rounded-md border border-dashed p-2 text-center text-[11px] text-muted-foreground"
                    >
                      <span className="truncate">{item.originalFilename}</span>
                      <span className={cn(item.status === "failed" && "text-destructive")}>
                        {item.status === "pending"
                          ? "Not uploaded"
                          : item.status === "failed"
                            ? (item.error ?? "Failed")
                            : "Queued"}
                      </span>
                    </li>
                  ))}
              </ul>
            </TabsContent>
          ))}
        </Tabs>
      )}

      <PreviewDialog output={preview} onClose={() => setPreview(null)} />
    </main>
  );
}

function BulkSave({ outputs }: { outputs: CloudOutputView[] }) {
  const [cursor, setCursor] = useState(0);
  const [prepared, setPrepared] = useState<File[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const remaining = outputs.length - cursor;
  const chunk = outputs.slice(cursor, cursor + SAVE_CHUNK);
  const range = `${cursor + 1}–${cursor + chunk.length}`;

  const prepare = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const files = await preparePngFiles(
        chunk.map((o) => ({ url: o.pngUrl!, name: o.name }))
      );
      if (canShareFiles(files)) {
        setPrepared(files);
      } else {
        await savePngFiles(files);
        setCursor((c) => c + chunk.length);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!prepared) return;
    try {
      await savePngFiles(prepared);
      setCursor((c) => c + prepared.length);
      setPrepared(null);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setMessage(e instanceof Error ? e.message : String(e));
      }
    }
  };

  if (outputs.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {remaining <= 0 ? (
        <>
          <p className="text-sm text-muted-foreground">All {outputs.length} saved.</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCursor(0)}>
            Start over
          </Button>
        </>
      ) : prepared ? (
        <Button type="button" className="min-h-11" onClick={() => void share()}>
          <Share className="size-4" />
          Save photos {range} to Photos
        </Button>
      ) : (
        <Button type="button" className="min-h-11" disabled={busy} onClick={() => void prepare()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {cursor === 0 ? `Save all ${outputs.length}` : "Continue"} — get photos {range}
        </Button>
      )}
      {message && <p className="text-xs text-destructive">{message}</p>}
      <p className="w-full text-[11px] text-muted-foreground">
        On iPhone, choose “Save Images” in the share sheet to add them to Photos ({SAVE_CHUNK} at a
        time).
      </p>
    </div>
  );
}

function PreviewDialog({ output, onClose }: { output: CloudOutputView | null; onClose: () => void }) {
  return (
    <Dialog open={!!output} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-3xl">
        {output && <PreviewBody key={output.id} output={output} />}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ output }: { output: CloudOutputView }) {
  const [prepared, setPrepared] = useState<File[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!output.pngUrl) return;
    let cancelled = false;
    preparePngFiles([{ url: output.pngUrl, name: output.name }])
      .then((files) => {
        if (!cancelled) setPrepared(files);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [output.name, output.pngUrl]);

  return (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono text-sm">{output.name}.png</DialogTitle>
              <DialogDescription>
                {TILE_BLEND_SHORT_LABELS[output.algorithm]}
                {output.width ? ` · ${output.width}×${output.height}` : ""}
                {output.sampleName ? ` · matched ${output.sampleName}` : ""}
              </DialogDescription>
            </DialogHeader>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={output.pngUrl ?? output.thumbUrl ?? ""}
              alt={output.name}
              className="max-h-[65vh] w-full rounded object-contain"
            />
            <div className="flex flex-wrap gap-2">
              {prepared && canShareFiles(prepared) && (
                <Button
                  type="button"
                  className="min-h-11"
                  onClick={() =>
                    void savePngFiles(prepared).catch((e) => {
                      if (!(e instanceof DOMException && e.name === "AbortError")) {
                        setError(e instanceof Error ? e.message : String(e));
                      }
                    })
                  }
                >
                  <Share className="size-4" />
                  Save to Photos
                </Button>
              )}
              {output.downloadUrl && (
                <Button asChild variant="outline" className="min-h-11">
                  <a href={output.downloadUrl} download={`${output.name}.png`}>
                    <Download className="size-4" />
                    Download
                  </a>
                </Button>
              )}
              {output.canEdit && (
                <Button asChild variant="secondary" className="min-h-11">
                  <Link href={editHref(output.id)}>
                    <Pencil className="size-4" />
                    Edit
                  </Link>
                </Button>
              )}
            </div>
            {!output.canEdit && (
              <p className="text-xs text-muted-foreground">
                Editing needs the original DNG, which has been cleared from storage.
              </p>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </>
  );
}
