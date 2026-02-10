"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { decode } from "@/src/lib/pipeline/decode";
import { frameToImageData } from "@/src/lib/pipeline/exportStage";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import { imageToEmbedding } from "@/src/lib/embeddings";
import { imageToSemanticEmbedding } from "@/src/lib/semanticEmbeddings";
import Link from "next/link";

type UploadResult = {
  file: string;
  status: "pending" | "uploading" | "ok" | "error";
  message?: string;
};

export default function DatasetPage() {
  const [results, setResults] = useState<UploadResult[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    setResults(list.map((f) => ({ file: f.name, status: "pending" as const })));
    setIsProcessing(true);

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      setResults((prev) =>
        prev.map((r, j) =>
          j === i ? { ...r, status: "uploading" as const } : r
        )
      );
      try {
        const frame = await decode(file);
        const imageData = frameToImageData(frame);
        const lookParams = fitLookParamsFromReference(imageData);
        const embedding = imageToEmbedding(imageData);
        const embeddingSemantic = await imageToSemanticEmbedding(file);

        const formData = new FormData();
        formData.append("file", file);
        formData.append("lookParams", JSON.stringify(lookParams));
        formData.append("embedding", JSON.stringify(embedding));
        formData.append("embeddingSemantic", JSON.stringify(embeddingSemantic));

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
  }, []);

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

        {isProcessing && (
          <p className="text-xs text-muted-foreground">
            Processing… (decode → fit LookParams → tonal + semantic embed →
            upload)
          </p>
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
