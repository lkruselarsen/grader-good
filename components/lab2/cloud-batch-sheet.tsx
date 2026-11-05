"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { GrainFields } from "@/components/grain/grain-fields";
import { Accordion } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  createCloudJob,
  formatBytes,
  markCloudItemUploaded,
  uploadToSignedUrl,
  type CreatedCloudJob,
} from "@/lib/cloud/client";
import { DEFAULT_CLOUD_EXPORT_SCALE } from "@/lib/cloud/settings";
import {
  CLOUD_EXPORT_SCALES,
  CLOUD_MAX_ALGORITHMS,
  type CloudExportScale,
} from "@/lib/cloud/types";
import { loadGrainParamsFromStorage, saveGrainParamsToStorage } from "@/lib/grain/constants";
import type { GrainExportParams } from "@/lib/grain/types";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import { ALL_TILE_BLENDS, TILE_BLEND_SHORT_LABELS, type Lab2TileBlend } from "@/lib/lab2/types";
import { cn } from "@/lib/utils";
import {
  FinishingEffectsCard,
  Lab2LookAccordionItems,
  type UpdateLookMatch,
} from "./lab2-look-sections";

const UPLOAD_CONCURRENCY = 2;
const UPLOAD_ATTEMPTS = 3;

type FileProgress = {
  name: string;
  loaded: number;
  total: number;
  status: "queued" | "uploading" | "done" | "failed";
  error?: string;
};

type Phase = "settings" | "uploading" | "uploaded" | "error";

type WakeLockSentinelLike = { release: () => Promise<void> };

function useScreenWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
    };
    if (!nav.wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;
    const acquire = () => {
      nav.wakeLock
        ?.request("screen")
        .then((s) => {
          if (cancelled) void s.release();
          else sentinel = s;
        })
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
    };
  }, [active]);
}

async function withRetries<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

export function CloudBatchSheet({
  open,
  files,
  lookParams,
  updateMatch,
  effectsEnabled,
  onEffectsEnabledChange,
  exportActuance,
  model2Strength,
  model2Robust,
  defaultAlgorithm,
  onOpenChange,
}: {
  open: boolean;
  files: File[];
  lookParams: LookParamsT;
  updateMatch: UpdateLookMatch;
  effectsEnabled: boolean;
  onEffectsEnabledChange: (v: boolean) => void;
  exportActuance: boolean;
  model2Strength: number;
  model2Robust: boolean;
  defaultAlgorithm: Lab2TileBlend;
  onOpenChange: (open: boolean) => void;
}) {
  const [algorithms, setAlgorithms] = useState<Lab2TileBlend[]>([defaultAlgorithm]);
  const [exportScale, setExportScale] = useState<CloudExportScale>(DEFAULT_CLOUD_EXPORT_SCALE);
  const [withGrain, setWithGrain] = useState(true);
  const [grain, setGrain] = useState<GrainExportParams>(() => loadGrainParamsFromStorage());
  const [phase, setPhase] = useState<Phase>("settings");
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<CreatedCloudJob | null>(null);
  const [progress, setProgress] = useState<FileProgress[]>([]);
  const [copied, setCopied] = useState(false);
  const filesRef = useRef(files);
  filesRef.current = files;

  useScreenWakeLock(phase === "uploading");

  const resetForNewBatch = useCallback(() => {
    setPhase("settings");
    setJob(null);
    setProgress([]);
    setError(null);
  }, []);

  const toggleAlgorithm = (blend: Lab2TileBlend, checked: boolean) => {
    setAlgorithms((prev) => {
      if (!checked) return prev.filter((b) => b !== blend);
      if (prev.includes(blend) || prev.length >= CLOUD_MAX_ALGORITHMS) return prev;
      return ALL_TILE_BLENDS.filter((b) => b === blend || prev.includes(b));
    });
  };

  const updateGrain = (patch: Partial<GrainExportParams>) => {
    setGrain((prev) => {
      const next = { ...prev, ...patch };
      saveGrainParamsToStorage(next);
      return next;
    });
  };

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const nonDng = files.filter((f) => !/\.dng$/i.test(f.name));

  const start = async () => {
    const batch = filesRef.current;
    if (!batch.length || !algorithms.length) return;
    setError(null);
    let created: CreatedCloudJob;
    try {
      created = await createCloudJob(
        {
          lookParams,
          effectsEnabled,
          exportActuance,
          model2Strength,
          model2Robust,
          withGrain,
          grain,
          exportScale,
          algorithms,
        },
        batch
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      return;
    }
    setJob(created);
    setPhase("uploading");
    setProgress(
      batch.map((f) => ({ name: f.name, loaded: 0, total: f.size, status: "queued" as const }))
    );
    const patch = (idx: number, p: Partial<FileProgress>) =>
      setProgress((prev) => prev.map((row, i) => (i === idx ? { ...row, ...p } : row)));

    let next = 0;
    const runOne = async () => {
      for (;;) {
        const i = next++;
        if (i >= batch.length) return;
        const upload = created.uploads[i]!;
        patch(i, { status: "uploading" });
        try {
          await withRetries(
            () =>
              uploadToSignedUrl(upload.signedUrl, batch[i]!, (loaded, total) =>
                patch(i, { loaded, total })
              ),
            UPLOAD_ATTEMPTS
          );
          await withRetries(() => markCloudItemUploaded(upload.id), UPLOAD_ATTEMPTS);
          patch(i, { status: "done", loaded: batch[i]!.size });
        } catch (e) {
          patch(i, { status: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, runOne));
    setPhase("uploaded");
  };

  const uploadedBytes = progress.reduce((s, p) => s + Math.min(p.loaded, p.total), 0);
  const doneCount = progress.filter((p) => p.status === "done").length;
  const failed = progress.filter((p) => p.status === "failed");

  const copyUrl = async () => {
    if (!job) return;
    try {
      await navigator.clipboard.writeText(job.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the URL is shown as text */
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (phase === "uploading" && !next) return;
        onOpenChange(next);
        if (!next && phase !== "settings") resetForNewBatch();
      }}
    >
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-lg"
        showCloseButton={phase !== "uploading"}
      >
        <SheetHeader>
          <SheetTitle>Cloud upload</SheetTitle>
          <SheetDescription>
            {files.length} DNG{files.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}. Nothing is
            processed on this device; every photo is graded at full RAW resolution in the cloud.
          </SheetDescription>
        </SheetHeader>

        {job && (
          <div className="mx-4 space-y-2 rounded-lg border bg-muted/40 p-3">
            <p className="text-sm font-medium">
              Your photos will be ready at this URL, usually within an hour:
            </p>
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer"
              className="block break-all text-sm text-primary underline"
            >
              {job.url}
            </a>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded bg-background px-2 py-1 text-xs">
                {job.url}
              </code>
              <Button type="button" size="sm" variant="outline" onClick={() => void copyUrl()}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        {phase === "settings" || phase === "error" ? (
          <div className="space-y-5 px-4 pb-4">
            {nonDng.length > 0 && (
              <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                {nonDng.map((f) => f.name).join(", ")} {nonDng.length === 1 ? "is" : "are"} not DNG.
                On iPhone, pick RAW files from the Files app (the Photos picker can convert them to
                JPEG).
              </p>
            )}
            <section className="space-y-2">
              <p className="text-sm font-medium">Algorithms (up to {CLOUD_MAX_ALGORITHMS})</p>
              {ALL_TILE_BLENDS.map((blend) => (
                <div key={blend} className="flex min-h-11 items-center gap-2 touch-manipulation">
                  <Checkbox
                    id={`cloud-algo-${blend}`}
                    checked={algorithms.includes(blend)}
                    onCheckedChange={(c) => toggleAlgorithm(blend, c === true)}
                  />
                  <Label htmlFor={`cloud-algo-${blend}`} className="cursor-pointer text-sm">
                    {TILE_BLEND_SHORT_LABELS[blend]}
                    {blend === "semantic" ? " (semantic)" : ""}
                  </Label>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Each algorithm becomes its own folder on the download page.
              </p>
            </section>

            <Separator />

            <section className="space-y-3">
              <p className="text-sm font-medium">Export</p>
              <div className="flex gap-2">
                {CLOUD_EXPORT_SCALES.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    size="sm"
                    variant={exportScale === s ? "default" : "outline"}
                    onClick={() => setExportScale(s)}
                  >
                    {Math.round(s * 100)}%
                  </Button>
                ))}
              </div>
              <div className="flex min-h-11 items-center justify-between gap-3">
                <Label htmlFor="cloud-with-grain" className="text-sm">
                  With grain
                </Label>
                <Switch
                  id="cloud-with-grain"
                  checked={withGrain}
                  onCheckedChange={(c) => setWithGrain(c === true)}
                />
              </div>
              {withGrain && <GrainFields params={grain} idPrefix="cloud-grain" onChange={updateGrain} />}
            </section>

            <Separator />

            <section className="space-y-3">
              <p className="text-sm font-medium">Look settings</p>
              <p className="text-xs text-muted-foreground">
                These are the current lab2 settings and apply to every photo in the batch.
              </p>
              <Accordion type="multiple" className="w-full">
                <Lab2LookAccordionItems
                  lookParams={lookParams}
                  updateMatch={updateMatch}
                  beginDrag={() => {}}
                />
              </Accordion>
              <FinishingEffectsCard
                lookParams={lookParams}
                enabled={effectsEnabled}
                onEnabledChange={onEffectsEnabledChange}
                updateMatch={updateMatch}
              />
            </section>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              type="button"
              className="min-h-11 w-full"
              disabled={!files.length || !algorithms.length || nonDng.length > 0}
              onClick={() => void start()}
            >
              Upload and process
            </Button>
          </div>
        ) : (
          <div className="space-y-4 px-4 pb-4">
            {phase === "uploading" ? (
              <p className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" />
                Uploading {doneCount}/{progress.length} — keep this screen open until the upload
                finishes.
              </p>
            ) : (
              <p className="text-sm font-medium">
                {failed.length === 0
                  ? "Upload complete – you can lock your phone now. Processing continues in the cloud."
                  : `Uploaded ${doneCount}/${progress.length}. ${failed.length} file(s) failed; the rest are processing in the cloud.`}
              </p>
            )}
            <Progress value={totalBytes ? (uploadedBytes / totalBytes) * 100 : 0} />
            <ul className="space-y-1 text-xs">
              {progress.map((p) => (
                <li key={p.name} className="flex items-center justify-between gap-2">
                  <span className="truncate">{p.name}</span>
                  <span
                    className={cn(
                      "shrink-0 tabular-nums text-muted-foreground",
                      p.status === "done" && "text-emerald-600 dark:text-emerald-400",
                      p.status === "failed" && "text-destructive"
                    )}
                    title={p.error}
                  >
                    {p.status === "uploading"
                      ? `${Math.round((p.loaded / Math.max(1, p.total)) * 100)}%`
                      : p.status}
                  </span>
                </li>
              ))}
            </ul>
            {phase === "uploaded" && job && (
              <Button asChild className="min-h-11 w-full">
                <a href={job.url}>Open download page</a>
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
