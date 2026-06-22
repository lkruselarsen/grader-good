"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { FileDropzone } from "@/components/app/file-dropzone";
import { EmptyState } from "@/components/app/empty-state";
import { ProgressWithLabel } from "@/components/app/progress-with-label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { frameToImageData, computeImageStats } from "@/src/lib/pipeline";
import { decode } from "@/src/lib/pipeline/decode";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import { imageToEmbedding } from "@/src/lib/embeddings";
import { imageToSemanticEmbedding } from "@/src/lib/semanticEmbeddings";
import {
  imageToChromaticTileEmbeddings,
  imageToColClipTileEmbeddings,
  imageToTonalTileEmbeddings,
} from "@/src/lib/colclipEmbeddings";

type UploadResult = {
  file: string;
  status: "pending" | "uploading" | "ok" | "error";
  message?: string;
};

const GRID_COLS = 10;
const GRID_ROWS = 10;

type UploadProgress = {
  fileIndex: number;
  fileTotal: number;
  phase: string;
  tileCurrent?: number;
  tileTotal?: number;
};

function statusBadgeVariant(
  status: UploadResult["status"]
): "secondary" | "default" | "destructive" | "outline" {
  switch (status) {
    case "ok":
      return "default";
    case "error":
      return "destructive";
    case "uploading":
      return "secondary";
    default:
      return "outline";
  }
}

export default function DatasetPage() {
  const [results, setResults] = useState<UploadResult[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [includeTiles, setIncludeTiles] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      const list = Array.from(files);
      setResults(list.map((f) => ({ file: f.name, status: "pending" as const })));
      setIsProcessing(true);
      const fileTotal = list.length;

      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        setResults((prev) =>
          prev.map((r, j) =>
            j === i ? { ...r, status: "uploading" as const } : r
          )
        );
        setUploadProgress({
          fileIndex: i + 1,
          fileTotal,
          phase: "Decoding…",
        });
        try {
          const frame = await decode(file);
          const imageData = frameToImageData(frame);
          setUploadProgress({
            fileIndex: i + 1,
            fileTotal,
            phase: "Fitting & embedding…",
          });
          const lookParams = fitLookParamsFromReference(imageData);
          const embedding = imageToEmbedding(imageData);
          const embeddingSemantic = await imageToSemanticEmbedding(file);
          const refStats = computeImageStats(imageData);

          const formData = new FormData();
          formData.append("file", file);
          formData.append("lookParams", JSON.stringify(lookParams));
          formData.append("embedding", JSON.stringify(embedding));
          formData.append("embeddingSemantic", JSON.stringify(embeddingSemantic));
          formData.append(
            "reference_exposure",
            JSON.stringify(refStats.exposureLevel)
          );
          formData.append(
            "reference_chroma_distribution",
            JSON.stringify(refStats.chromaDistribution)
          );

          if (includeTiles) {
            const totalTiles = GRID_COLS * GRID_ROWS;
            setUploadProgress({
              fileIndex: i + 1,
              fileTotal,
              phase: "Tiles",
              tileCurrent: 0,
              tileTotal: totalTiles,
            });
            const colclipTiles = await imageToColClipTileEmbeddings(
              imageData,
              GRID_COLS,
              GRID_ROWS,
              (current, total) =>
                setUploadProgress({
                  fileIndex: i + 1,
                  fileTotal,
                  phase: "Tiles",
                  tileCurrent: current,
                  tileTotal: total,
                })
            );
            const tonalTiles = imageToTonalTileEmbeddings(
              imageData,
              GRID_COLS,
              GRID_ROWS
            );
            const chromaTiles = imageToChromaticTileEmbeddings(
              imageData,
              GRID_COLS,
              GRID_ROWS
            );
            const tileEmbeddings = colclipTiles.map((vec, idx) => ({
              tile_index: idx,
              embedding_colclip: vec,
              embedding_tonal: tonalTiles[idx],
              embedding_tonal_chroma: chromaTiles[idx],
            }));
            formData.append("tileEmbeddings", JSON.stringify(tileEmbeddings));
          }

          setUploadProgress({
            fileIndex: i + 1,
            fileTotal,
            phase: "Uploading…",
          });
          const res = await fetch("/api/dataset/upload", {
            method: "POST",
            body: formData,
          });
          const data = await res.json();

          if (!res.ok) {
            throw new Error(data.error ?? "Upload failed");
          }
          setResults((prev) =>
            prev.map((r, j) =>
              j === i
                ? { ...r, status: "ok" as const, message: data.id }
                : r
            )
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setResults((prev) =>
            prev.map((r, j) =>
              j === i ? { ...r, status: "error" as const, message: msg } : r
            )
          );
        }
      }
      setIsProcessing(false);
      setUploadProgress(null);
    },
    [includeTiles]
  );

  const progressValue =
    uploadProgress && uploadProgress.fileTotal > 0
      ? (100 *
          (uploadProgress.fileIndex -
            1 +
            (uploadProgress.tileTotal != null && uploadProgress.tileTotal > 0
              ? (uploadProgress.tileCurrent ?? 0) / uploadProgress.tileTotal
              : 1))) /
        uploadProgress.fileTotal
      : undefined;

  const progressLabel = uploadProgress
    ? `File ${uploadProgress.fileIndex} of ${uploadProgress.fileTotal}${
        uploadProgress.tileTotal != null && uploadProgress.tileTotal > 0
          ? ` — ${uploadProgress.tileCurrent ?? 0} of ${uploadProgress.tileTotal} tiles`
          : ` — ${uploadProgress.phase}`
      }`
    : "";

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Dataset"
        href="/dataset"
        description="Upload reference photos to build your grading embeddings database. Each image is analyzed, LookParams are fitted, and 32-dim tonal + 16-dim per-tile chroma + 384-dim semantic embeddings are stored for similarity search (when tiles are enabled)."
      />

      <Card className="space-y-4 p-6">
        <FileDropzone
          id="dataset-files"
          label="Add samples (JPG/PNG)"
          accept="image/jpeg,image/png"
          multiple
          disabled={isProcessing}
          onFiles={handleFiles}
        />

        <div className="flex items-center gap-2">
          <Checkbox
            id="include-tiles"
            checked={includeTiles}
            onCheckedChange={(checked) => setIncludeTiles(checked === true)}
            disabled={isProcessing}
          />
          <Label htmlFor="include-tiles" className="text-sm">
            Include tile embeddings (10×10, slower; for fine-grained search)
          </Label>
        </div>

        {!isProcessing && results.length === 0 && (
          <EmptyState
            title="No samples uploaded yet"
            description="Drop JPG or PNG reference images above to add them to your embeddings database."
          />
        )}

        {results.length > 0 && (
          <ul className="space-y-2 text-sm">
            {results.map((r, i) => (
              <li key={i} className="flex items-center gap-2">
                <Badge variant={statusBadgeVariant(r.status)} className="shrink-0">
                  {r.status}
                </Badge>
                <span className="truncate">{r.file}</span>
                {r.message && (
                  <span className="max-w-[12rem] truncate text-xs text-muted-foreground">
                    {r.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {isProcessing && uploadProgress && (
          <ProgressWithLabel
            value={progressValue}
            label={progressLabel}
            indeterminate={
              uploadProgress.fileTotal <= 0 ||
              (uploadProgress.tileTotal != null && uploadProgress.tileTotal > 0
                ? false
                : progressValue === undefined)
            }
          />
        )}
      </Card>

      <p className="mt-6 text-xs text-muted-foreground">
        Configure{" "}
        <code className="rounded bg-muted px-1">NEXT_PUBLIC_SUPABASE_URL</code>{" "}
        and{" "}
        <code className="rounded bg-muted px-1">SUPABASE_SERVICE_ROLE_KEY</code>{" "}
        in .env.local. Run{" "}
        <code className="rounded bg-muted px-1">npx supabase db push</code> to
        apply migrations. View uploaded samples on the{" "}
        <Link href="/matches" className="underline hover:text-foreground">
          Match list
        </Link>
        .
      </p>
    </div>
  );
}
