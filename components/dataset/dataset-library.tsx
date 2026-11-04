"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { deleteDatasetSample } from "@/lib/cloud/client";

export type DatasetSample = {
  id: string;
  name: string | null;
  image_url: string;
  thumb_url: string | null;
  created_at: string;
  hasTonal: boolean;
  hasSemantic: boolean;
};

type SamplesResponse = {
  samples: DatasetSample[];
  total: number;
  error?: string;
};

const PAGE_SIZE = 100;

/** Thumbnail grid of every reference in the embeddings dataset, with delete. */
export function DatasetLibrary({ refreshKey = 0 }: { refreshKey?: number }) {
  const [samples, setSamples] = useState<DatasetSample[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DatasetSample | null>(null);

  const load = useCallback(async (nextPage: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/dataset/samples?page=${nextPage}&limit=${PAGE_SIZE}`,
        {
          cache: "no-store",
        },
      );
      const json = (await res.json()) as SamplesResponse;
      if (!res.ok) throw new Error(json.error ?? "Failed to load samples");
      setSamples((prev) =>
        append ? [...prev, ...json.samples] : json.samples,
      );
      setTotal(json.total);
      setPage(nextPage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(1, false);
  }, [load, refreshKey]);

  const onDeleted = useCallback((id: string) => {
    setSamples((prev) => prev.filter((s) => s.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    setSelected(null);
  }, []);

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Library</h2>
        <p className="text-xs text-muted-foreground">
          {total} reference{total === 1 ? "" : "s"}
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {samples.length === 0 && loading ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square w-full" />
          ))}
        </div>
      ) : samples.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No references in the dataset yet.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
          {samples.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelected(s)}
              className="group relative aspect-square overflow-hidden rounded border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              title={s.name ?? "Untitled"}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.thumb_url ?? s.image_url}
                alt={s.name ?? "Sample"}
                loading="lazy"
                decoding="async"
                className="size-full object-cover transition-opacity group-hover:opacity-80"
              />
            </button>
          ))}
        </div>
      )}
      {samples.length < total && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={loading}
          onClick={() => void load(page + 1, true)}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            `Load more (${total - samples.length} left)`
          )}
        </Button>
      )}
      <SampleDialog
        sample={selected}
        onClose={() => setSelected(null)}
        onDeleted={onDeleted}
      />
    </Card>
  );
}

function SampleDialog({
  sample,
  onClose,
  onDeleted,
}: {
  sample: DatasetSample | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  return (
    <Dialog open={!!sample} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-2xl">
        {sample && (
          <SampleBody key={sample.id} sample={sample} onDeleted={onDeleted} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SampleBody({
  sample,
  onDeleted,
}: {
  sample: DatasetSample;
  onDeleted: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tileCount, setTileCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dataset/samples/${sample.id}`, { cache: "no-store" })
      .then((res) => res.json() as Promise<{ tileCount?: number }>)
      .then((json) => {
        if (!cancelled && typeof json.tileCount === "number")
          setTileCount(json.tileCount);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sample.id]);

  const remove = async () => {
    setDeleting(true);
    try {
      const res = await deleteDatasetSample(sample.id);
      if (res.storageError) {
        toast.warning(
          `Removed from the dataset, but the image file could not be deleted: ${res.storageError}`,
        );
      } else {
        toast.success(
          `Deleted ${sample.name ?? "reference"} from the dataset.`,
        );
      }
      onDeleted(sample.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="truncate text-sm">
          {sample.name ?? "Untitled"}
        </DialogTitle>
        <DialogDescription>
          Added{" "}
          {new Date(sample.created_at).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </DialogDescription>
      </DialogHeader>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={sample.image_url}
        alt={sample.name ?? "Sample"}
        className="max-h-[60vh] w-full rounded bg-contain bg-center bg-no-repeat object-contain"
        style={
          sample.thumb_url
            ? { backgroundImage: `url(${sample.thumb_url})` }
            : undefined
        }
      />
      <div className="flex flex-wrap gap-1">
        <Badge variant={sample.hasTonal ? "secondary" : "outline"}>
          {sample.hasTonal ? "Tonal" : "No tonal"}
        </Badge>
        <Badge variant={sample.hasSemantic ? "secondary" : "outline"}>
          {sample.hasSemantic ? "Semantic" : "No semantic"}
        </Badge>
        {tileCount !== null && (
          <Badge variant={tileCount > 0 ? "secondary" : "outline"}>
            {tileCount > 0 ? `${tileCount} tiles` : "No tiles"}
          </Badge>
        )}
      </div>
      {confirming ? (
        <div className="space-y-3 rounded-md border border-destructive/40 p-3">
          <p className="text-sm">
            Delete this reference and all of its embeddings? It will no longer
            be matched, and cloud photos graded from it can no longer switch
            back to it.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete permanently
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-fit text-destructive"
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="size-4" />
          Delete from dataset
        </Button>
      )}
    </>
  );
}
