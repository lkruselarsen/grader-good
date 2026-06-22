"use client";

import { useEffect, useRef } from "react";
import { useCustomShapes } from "@/hooks/use-custom-shapes";
import { parseImportPayload } from "@/lib/loaders/custom-shapes/bundle";
import { LOADER_LAB_PENDING_IMPORT_KEY } from "@/lib/loaders/saved-presets";
import type { LoaderDefinition } from "@/lib/loaders/types";
import { toast } from "sonner";

type LoaderLabPendingImportProps = {
  onLoad: (definition: LoaderDefinition) => void;
};

export function LoaderLabPendingImport({ onLoad }: LoaderLabPendingImportProps) {
  const { shapes, mergeShapes } = useCustomShapes();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;

    try {
      const raw = localStorage.getItem(LOADER_LAB_PENDING_IMPORT_KEY);
      if (!raw) return;

      localStorage.removeItem(LOADER_LAB_PENDING_IMPORT_KEY);
      handled.current = true;

      const parsed = JSON.parse(raw) as unknown;
      const result = parseImportPayload(parsed, shapes);
      if (!result) {
        toast.error("Could not load preset from library");
        return;
      }

      const { merged, skipped } = mergeShapes(result.shapesToMerge);
      onLoad(result.definition);

      if (skipped > 0) {
        toast.warning(
          `Opened preset but ${skipped} custom shape(s) could not be imported`
        );
      } else if (result.missingShapeIds.length > 0) {
        toast.warning(
          `Opened preset but ${result.missingShapeIds.length} custom shape(s) are missing`
        );
      } else {
        toast.success(
          merged > 0
            ? `Opened preset with ${merged} custom shape(s)`
            : "Opened preset from library"
        );
      }
    } catch {
      toast.error("Could not load preset from library");
    }
  }, [shapes, mergeShapes, onLoad]);

  return null;
}
