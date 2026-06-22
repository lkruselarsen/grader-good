"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileDropzone } from "@/components/app/file-dropzone";
import { CUSTOM_SHAPE_LIMITS } from "@/lib/loaders/custom-shapes/types";
import { parseShapeFile } from "@/lib/loaders/custom-shapes/parse-png";
import type { CustomGridShape } from "@/lib/loaders/custom-shapes/types";
import { useCustomShapes } from "@/hooks/use-custom-shapes";
import { toast } from "sonner";

type CustomShapeUploadDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShapeAdded?: (shape: CustomGridShape) => void;
};

function ShapePreview({ shape }: { shape: CustomGridShape }) {
  if (shape.kind === "png") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={shape.dataUrl}
        alt={shape.name}
        className="size-16 object-contain"
      />
    );
  }

  return (
    <svg
      viewBox={shape.viewBox}
      className="size-16 text-primary"
      aria-hidden
    >
      <g
        fill="currentColor"
        dangerouslySetInnerHTML={{ __html: shape.markup }}
      />
    </svg>
  );
}

export function CustomShapeUploadDialog({
  open,
  onOpenChange,
  onShapeAdded,
}: CustomShapeUploadDialogProps) {
  const { addShape } = useCustomShapes();
  const [pending, setPending] = useState<CustomGridShape | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);

  const reset = useCallback(() => {
    setPending(null);
    setWarnings([]);
    setError(null);
    setParsing(false);
  }, []);

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;

    setParsing(true);
    setError(null);
    setPending(null);
    setWarnings([]);

    const result = await parseShapeFile(file);
    setParsing(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setPending(result.shape);
    setWarnings(result.warnings);
  };

  const handleConfirm = () => {
    if (!pending) return;

    const result = addShape(pending);
    if (!result.ok) {
      setError(result.error);
      toast.error(result.error);
      return;
    }

    toast.success(`Added shape "${pending.name}"`);
    onShapeAdded?.(pending);
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload new shape</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Upload an SVG or PNG to use as a grid unit shape.</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="py-1 text-left font-medium">Format</th>
                    <th className="py-1 text-left font-medium">Max size</th>
                    <th className="py-1 text-left font-medium">Ideal size</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="py-1">SVG</td>
                    <td className="py-1">
                      {CUSTOM_SHAPE_LIMITS.svgMaxBytes / 1024} KB
                    </td>
                    <td className="py-1">16×16 viewBox</td>
                  </tr>
                  <tr>
                    <td className="py-1">PNG</td>
                    <td className="py-1">
                      {CUSTOM_SHAPE_LIMITS.pngMaxBytes / 1024} KB
                    </td>
                    <td className="py-1">16×16 px</td>
                  </tr>
                </tbody>
              </table>
              <p className="text-xs">
                PNG max dimensions: {CUSTOM_SHAPE_LIMITS.pngMaxDimension}×
                {CUSTOM_SHAPE_LIMITS.pngMaxDimension}px. Shape name comes from
                the filename.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <FileDropzone
          accept=".svg,.png,image/svg+xml,image/png"
          onFiles={handleFiles}
          disabled={parsing}
        />

        {parsing ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Parsing file…
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}

        {pending ? (
          <div className="flex items-center gap-4 rounded-md border border-border p-3">
            <div className="flex size-20 shrink-0 items-center justify-center rounded-md bg-muted/50">
              <ShapePreview shape={pending} />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium">{pending.name}</p>
              <p className="text-xs text-muted-foreground">
                {pending.kind.toUpperCase()}
                {pending.kind === "png"
                  ? ` · ${pending.width}×${pending.height}`
                  : ` · ${pending.viewBox}`}
              </p>
              {warnings.map((w) => (
                <p key={w} className="text-xs text-amber-600 dark:text-amber-500">
                  {w}
                </p>
              ))}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={!pending || parsing}
          >
            Add shape
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
