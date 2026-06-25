"use client";

import Link from "next/link";
import { Copy, ExternalLink, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";
import { ConfigurableLoader } from "@/components/loaders/configurable-loader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useLoaderLoops } from "@/hooks/use-loader-loops";
import { useSavedLoaders } from "@/hooks/use-saved-loaders";
import { LOADER_LOOP_LABELS, type LoaderLoopId } from "@/lib/loaders/loops";
import {
  bundleToShapesMap,
  LOADER_LAB_PENDING_IMPORT_KEY,
} from "@/lib/loaders/saved-presets";
import { toast } from "sonner";

function formatSavedAt(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const LOOP_IDS: LoaderLoopId[] = ["processing", "export"];

export function SavedLoadersShowcase() {
  const { presets, removePreset } = useSavedLoaders();
  const { isInLoop, setMembership } = useLoaderLoops();

  if (presets.length === 0) {
    return (
      <EmptyState
        title="No saved loaders yet"
        description="Create an animation in Loader Lab and click Save to add it here for review."
        action={
          <Button size="sm" variant="outline" asChild>
            <Link href="/loader-lab">Open Loader Lab</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {presets.map((preset) => {
        const customShapes = bundleToShapesMap(preset.bundle);

        const openInLab = () => {
          try {
            localStorage.setItem(
              LOADER_LAB_PENDING_IMPORT_KEY,
              JSON.stringify(preset.bundle)
            );
            window.location.href = "/loader-lab";
          } catch {
            toast.error("Could not open preset in Loader Lab");
          }
        };

        const copyJson = async () => {
          try {
            await navigator.clipboard.writeText(
              JSON.stringify(preset.bundle, null, 2)
            );
            toast.success("Copied preset JSON");
          } catch {
            toast.error("Could not copy to clipboard");
          }
        };

        const handleDelete = () => {
          const confirmed = window.confirm(`Remove "${preset.name}" from the library?`);
          if (confirmed) removePreset(preset.id);
        };

        return (
          <div
            key={preset.id}
            className="flex flex-col gap-3 rounded-lg border bg-card p-4"
          >
            <div className="flex min-h-[120px] items-center justify-center rounded-md bg-muted/40 p-4">
              <ConfigurableLoader
                definition={preset.bundle.definition}
                customShapes={customShapes}
                showLabel={preset.bundle.definition.label !== undefined}
              />
            </div>

            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium">{preset.name}</p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {preset.id}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatSavedAt(preset.savedAt)}
              </p>
            </div>

            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <p className="text-xs font-medium text-muted-foreground">Playlists</p>
              <div className="space-y-2">
                {LOOP_IDS.map((loopId) => {
                  const checkboxId = `${preset.id}-${loopId}`;
                  return (
                    <div key={loopId} className="flex items-center gap-2">
                      <Checkbox
                        id={checkboxId}
                        checked={isInLoop(loopId, preset.id)}
                        onCheckedChange={(checked) =>
                          setMembership(loopId, preset.id, checked === true)
                        }
                      />
                      <Label
                        htmlFor={checkboxId}
                        className="cursor-pointer text-xs font-normal"
                      >
                        {LOADER_LOOP_LABELS[loopId]}
                      </Label>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={openInLab}>
                <ExternalLink className="size-3.5" />
                Open in Lab
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={copyJson}>
                <Copy className="size-3.5" />
                Copy JSON
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={handleDelete}
                aria-label={`Remove ${preset.name}`}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
