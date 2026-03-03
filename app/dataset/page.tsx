"use client";

import { useCallback, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { frameToImageData, computeImageStats } from "@/src/lib/pipeline";
import { decode } from "@/src/lib/pipeline/decode";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import { imageToEmbedding } from "@/src/lib/embeddings";
import { imageToSemanticEmbedding } from "@/src/lib/semanticEmbeddings";
import { imageToColClipTileEmbeddings, imageToTonalTileEmbeddings } from "@/src/lib/colclipEmbeddings";
import Link from "next/link";

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

export default function DatasetPage() {
  const [results, setResults] = useState<UploadResult[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [includeTiles, setIncludeTiles] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);

  const handleFiles = useCallback(async (files: FileList | null) => {
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
        formData.append("reference_exposure", JSON.stringify(refStats.exposureLevel));
        formData.append("reference_chroma_distribution", JSON.stringify(refStats.chromaDistribution));

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
          const tonalTiles = imageToTonalTileEmbeddings(imageData, GRID_COLS, GRID_ROWS);
          const tileEmbeddings = colclipTiles.map((vec, idx) => ({
            tile_index: idx,
            embedding_colclip: vec,
            embedding_tonal: tonalTiles[idx],
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
  }, [includeTiles]);

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <div className="mb-6">
        <Link
          href="/lab"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Lab
        </Link>
      </div>

      <h1 className="text-2xl font-semibold mb-2">Dataset Builder</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Upload reference photos to build your grading embeddings database. Each
        image is analyzed, LookParams are fitted, and 32-dim tonal + 384-dim
        semantic embeddings are stored for similarity search.
      </p>

      <Card className="p-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="dataset-files">Add samples (JPG/PNG)</Label>
          <Input
            id="dataset-files"
            type="file"
            accept="image/jpeg,image/png"
            multiple
            disabled={isProcessing}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            id="include-tiles"
            type="checkbox"
            checked={includeTiles}
            onChange={(e) => setIncludeTiles(e.target.checked)}
            disabled={isProcessing}
          />
          <Label htmlFor="include-tiles" className="text-sm">
            Include tile embeddings (10×10, slower; for fine-grained search)
          </Label>
        </div>

        {results.length > 0 && (
          <ul className="space-y-2 text-sm">
            {results.map((r, i) => (
              <li
                key={i}
                className={`flex items-center gap-2 ${
                  r.status === "ok"
                    ? "text-green-600 dark:text-green-400"
                    : r.status === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                <span>
                  {r.status === "pending" && "⏳"}
                  {r.status === "uploading" && "⏳"}
                  {r.status === "ok" && "✓"}
                  {r.status === "error" && "✗"}
                </span>
                <span className="truncate">{r.file}</span>
                {r.message && (
                  <span className="text-xs truncate max-w-[12rem]">
                    {r.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {isProcessing && uploadProgress && (
          <div className="space-y-1">
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full bg-primary transition-all duration-300 ${
                  uploadProgress.fileTotal <= 0 ||
                  (uploadProgress.tileTotal != null && uploadProgress.tileTotal > 0)
                    ? ""
                    : "animate-pulse"
                }`}
                style={
                  uploadProgress.fileTotal > 0
                    ? {
                        width: `${(100 *
                          (uploadProgress.fileIndex -
                            1 +
                            (uploadProgress.tileTotal != null && uploadProgress.tileTotal > 0
                              ? (uploadProgress.tileCurrent ?? 0) / uploadProgress.tileTotal
                              : 1))) /
                          uploadProgress.fileTotal}%`,
                      }
                    : undefined
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              File {uploadProgress.fileIndex} of {uploadProgress.fileTotal}
              {uploadProgress.tileTotal != null &&
                uploadProgress.tileTotal > 0 &&
                ` — ${uploadProgress.tileCurrent ?? 0} of ${uploadProgress.tileTotal} tiles`}
              {uploadProgress.tileTotal == null && ` — ${uploadProgress.phase}`}
            </p>
          </div>
        )}
      </Card>

      <p className="mt-6 text-xs text-muted-foreground">
        Configure{" "}
        <code className="bg-muted px-1 rounded">NEXT_PUBLIC_SUPABASE_URL</code>{" "}
        and{" "}
        <code className="bg-muted px-1 rounded">SUPABASE_SERVICE_ROLE_KEY</code>{" "}
        in .env.local. Run{" "}
        <code className="bg-muted px-1 rounded">npx supabase db push</code> to
        apply migrations.
      </p>
    </div>
  );
}
