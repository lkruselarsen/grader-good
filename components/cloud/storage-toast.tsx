"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  clearCloudStorage,
  fetchCloudStorage,
  formatBytes,
  getCloudKey,
} from "@/lib/cloud/client";
import type { CloudStorageUsage } from "@/lib/cloud/types";

const SHOWN_KEY = "grader-good:cloud-storage-toast-shown";
const TOAST_ID = "cloud-storage";

const SCOPE_LABELS = {
  dngs: "Clear DNGs",
  exports: "Clear export PNGs",
  all: "Clear all",
} as const;

const SCOPE_CONFIRM = {
  dngs: "Delete every uploaded DNG? Photos can no longer be re-edited afterwards.",
  exports: "Delete every exported PNG? Download pages will show them as cleared.",
  all: "Delete all DNGs and exported PNGs from cloud storage?",
} as const;

function showUsage(usage: CloudStorageUsage) {
  const pct = usage.quotaBytes ? Math.round((usage.usedBytes / usage.quotaBytes) * 100) : 0;
  toast.custom(
    (id) => (
      <div className="w-[360px] max-w-[92vw] space-y-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
        <p className="text-sm font-medium">
          Cloud storage: {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)} ({pct}%)
        </p>
        <p className="text-xs text-muted-foreground">
          DNGs {formatBytes(usage.dngBytes)} · exports {formatBytes(usage.exportBytes)}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(SCOPE_LABELS) as Array<keyof typeof SCOPE_LABELS>).map((scope) => (
            <Button
              key={scope}
              type="button"
              size="sm"
              variant={scope === "all" ? "destructive" : "outline"}
              className="h-8 text-xs"
              onClick={async () => {
                if (!window.confirm(SCOPE_CONFIRM[scope])) return;
                try {
                  const res = await clearCloudStorage(scope);
                  toast.dismiss(id);
                  showUsage(res.usage);
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              {SCOPE_LABELS[scope]}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => toast.dismiss(id)}
          >
            Close
          </Button>
        </div>
      </div>
    ),
    { id: TOAST_ID, duration: 15_000 }
  );
}

/** Shows cloud storage usage once per browser session (only on devices with the passphrase). */
export function CloudStorageToast() {
  useEffect(() => {
    if (!getCloudKey()) return;
    try {
      if (sessionStorage.getItem(SHOWN_KEY)) return;
      sessionStorage.setItem(SHOWN_KEY, "1");
    } catch {
      /* private mode: show every time */
    }
    fetchCloudStorage()
      .then(showUsage)
      .catch(() => {});
  }, []);
  return null;
}
