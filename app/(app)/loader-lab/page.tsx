"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderLabControls } from "@/components/loader-lab/loader-lab-controls";
import { LoaderLabPendingImport } from "@/components/loader-lab/loader-lab-pending-import";
import { LoaderLabPreview } from "@/components/loader-lab/loader-lab-preview";
import { PageHeader } from "@/components/app/page-header";
import {
  PanelSidebar,
  PanelSidebarContent,
  PanelSidebarInset,
  PanelSidebarProvider,
  PanelSidebarTrigger,
} from "@/components/app/panel-sidebar";
import { CustomShapesProvider } from "@/hooks/use-custom-shapes";
import { DEFAULT_GRID_PRESET } from "@/lib/loaders/presets";
import type { LoaderDefinition } from "@/lib/loaders/types";

const DRAFT_STORAGE_KEY = "grader-good:loader-lab-draft";

function readDraft(): LoaderDefinition | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LoaderDefinition;
  } catch {
    return null;
  }
}

export default function LoaderLabPage() {
  const [definition, setDefinition] = useState<LoaderDefinition>(() =>
    structuredClone(DEFAULT_GRID_PRESET)
  );
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [paused, setPaused] = useState(false);
  const [manualFrame, setManualFrame] = useState(0);

  const handleDefinitionChange = useCallback((next: LoaderDefinition) => {
    setDefinition(next);
    setManualFrame(0);
  }, []);

  useEffect(() => {
    const draft = readDraft();
    if (draft) setDefinition(draft);
    setDraftHydrated(true);
  }, []);

  useEffect(() => {
    if (!draftHydrated) return;
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(definition));
    } catch {
      // ignore quota errors
    }
  }, [definition, draftHydrated]);

  return (
    <CustomShapesProvider>
      <LoaderLabPendingImport onLoad={handleDefinitionChange} />
      <PanelSidebarProvider defaultOpen>
        <div className="-m-4 flex min-h-[calc(100vh-3.5rem)] flex-col md:-m-6">
          <div className="flex min-h-0 flex-1 gap-0">
            <PanelSidebarInset className="flex min-h-0 flex-col p-0">
              <div className="border-b px-4 py-4 md:px-6">
                <PageHeader
                  title="Loader lab"
                  href="/loader-lab"
                  description="Design lightweight loading animations — grid, bar chart, or number list — with live preview and exportable presets."
                  className="mb-0"
                />
                <div className="mt-3 flex items-center gap-2 md:hidden">
                  <PanelSidebarTrigger />
                  <span className="text-sm text-muted-foreground">Controls</span>
                </div>
              </div>
              <LoaderLabPreview
                definition={definition}
                paused={paused}
                manualFrame={manualFrame}
                onLabelChange={(label) =>
                  setDefinition((current) => ({ ...current, label }))
                }
                onPausedChange={setPaused}
                onManualFrameChange={setManualFrame}
              />
            </PanelSidebarInset>

            <PanelSidebar collapsible="icon">
              <PanelSidebarContent>
                <LoaderLabControls
                  definition={definition}
                  onChange={handleDefinitionChange}
                />
              </PanelSidebarContent>
            </PanelSidebar>
          </div>
        </div>
      </PanelSidebarProvider>
    </CustomShapesProvider>
  );
}
