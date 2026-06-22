import type { LoaderExportBundle } from "./custom-shapes/bundle";
import { isLoaderExportBundle } from "./custom-shapes/bundle";

export type SavedLoaderPreset = {
  id: string;
  name: string;
  savedAt: string;
  bundle: LoaderExportBundle;
};

export const SAVED_LOADERS_STORAGE_KEY = "grader-good:saved-loaders";
export const LOADER_LAB_PENDING_IMPORT_KEY = "grader-good:loader-lab-pending-import";

export function createSavedLoaderPreset(
  bundle: LoaderExportBundle,
  name?: string
): SavedLoaderPreset {
  return {
    id: crypto.randomUUID(),
    name: name?.trim() || bundle.definition.name || "Untitled loader",
    savedAt: new Date().toISOString(),
    bundle,
  };
}

export function isSavedLoaderPreset(value: unknown): value is SavedLoaderPreset {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    typeof obj.savedAt === "string" &&
    isLoaderExportBundle(obj.bundle)
  );
}

export function bundleToShapesMap(
  bundle: LoaderExportBundle
): Record<string, NonNullable<LoaderExportBundle["customShapes"]>[number]> {
  if (!bundle.customShapes?.length) return {};
  return Object.fromEntries(bundle.customShapes.map((s) => [s.id, s]));
}
