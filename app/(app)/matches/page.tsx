"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type GradingSampleRow = {
  id: string;
  name: string | null;
  image_url: string;
  created_at: string;
  hasTonal: boolean;
  hasSemantic: boolean;
};

type SamplesResponse = {
  samples: GradingSampleRow[];
  total: number;
  page: number;
  limit: number;
  error?: string;
};

const PAGE_SIZE = 50;

export default function MatchesPage() {
  const [data, setData] = useState<SamplesResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/dataset/samples?page=${page}&limit=${PAGE_SIZE}`);
        const json = (await res.json()) as SamplesResponse;
        if (!res.ok) {
          throw new Error(json.error ?? "Failed to load samples");
        }
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load samples");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [page]);

  const columns = useMemo<ColumnDef<GradingSampleRow>[]>(
    () => [
      {
        accessorKey: "image_url",
        header: "Preview",
        cell: ({ row }) => (
          <div className="size-12 overflow-hidden rounded border bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={row.original.image_url}
              alt={row.original.name ?? "Sample"}
              className="size-full object-cover"
            />
          </div>
        ),
      },
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => row.original.name ?? "Untitled",
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) =>
          new Date(row.original.created_at).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
      },
      {
        id: "embeddings",
        header: "Embeddings",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.hasTonal ? (
              <Badge variant="secondary">Tonal</Badge>
            ) : (
              <Badge variant="outline">No tonal</Badge>
            )}
            {row.original.hasSemantic ? (
              <Badge variant="secondary">Semantic</Badge>
            ) : (
              <Badge variant="outline">No semantic</Badge>
            )}
          </div>
        ),
      },
    ],
    []
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Match list"
        href="/matches"
        description="Read-only view of grading samples available to the embeddings match algorithm."
      />

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : data && data.samples.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No grading samples yet. Upload references on the{" "}
            <Link href="/dataset" className="text-primary underline">
              Dataset
            </Link>{" "}
            page to build the match corpus.
          </p>
        </div>
      ) : data ? (
        <>
          <DataTable columns={columns} data={data.samples} />
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {data.total} sample{data.total === 1 ? "" : "s"} total
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
