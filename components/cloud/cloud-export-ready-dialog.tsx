"use client";

import { useState } from "react";
import { Download, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { canShareFiles, savePngFiles } from "@/lib/cloud/client";

/** A cloud re-render finished: save it (share sheet on iPhone) or download it. */
export function CloudExportReadyDialog({
  result,
  onClose,
}: {
  result: { files: File[]; name: string; downloadUrl: string | null } | null;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const shareable = !!result && canShareFiles(result.files);
  return (
    <Dialog
      open={!!result}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        {result && (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono text-sm">{result.name}.png</DialogTitle>
              <DialogDescription>
                Rendered from the full DNG in the cloud. It is also on the batch download page.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2">
              {shareable && (
                <Button
                  type="button"
                  className="min-h-11"
                  onClick={() =>
                    void savePngFiles(result.files).catch((e) => {
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
              {!shareable && (
                <Button
                  type="button"
                  className="min-h-11"
                  onClick={() => void savePngFiles(result.files)}
                >
                  <Download className="size-4" />
                  Download
                </Button>
              )}
              {shareable && result.downloadUrl && (
                <Button asChild variant="outline" className="min-h-11">
                  <a href={result.downloadUrl} download={`${result.name}.png`}>
                    <Download className="size-4" />
                    Download
                  </a>
                </Button>
              )}
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
