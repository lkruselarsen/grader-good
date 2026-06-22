import type { LoaderDefinition } from "../types";
import type { CustomGridShape } from "./types";
import { shapePayloadSize } from "./types";

export type LoaderExportBundle = {
  version: 1;
  definition: LoaderDefinition;
  customShapes?: CustomGridShape[];
};

export function collectReferencedShapeIds(
  definition: LoaderDefinition
): string[] {
  const ids = new Set<string>();
  for (const state of definition.states) {
    const customId = state.grid?.customShapeId;
    if (customId) ids.add(customId);
  }
  return Array.from(ids);
}

export function collectReferencedShapes(
  definition: LoaderDefinition,
  registry: CustomGridShape[]
): CustomGridShape[] {
  const ids = new Set(collectReferencedShapeIds(definition));
  return registry.filter((s) => ids.has(s.id));
}

export function buildExportBundle(
  definition: LoaderDefinition,
  registry: CustomGridShape[]
): LoaderExportBundle {
  const customShapes = collectReferencedShapes(definition, registry);
  return {
    version: 1,
    definition,
    customShapes: customShapes.length > 0 ? customShapes : undefined,
  };
}

export function isLoaderExportBundle(
  value: unknown
): value is LoaderExportBundle {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return obj.version === 1 && obj.definition != null;
}

export function isLoaderDefinition(value: unknown): value is LoaderDefinition {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.vizType === "string" &&
    Array.isArray(obj.states)
  );
}

export type ParseImportResult = {
  definition: LoaderDefinition;
  shapesToMerge: CustomGridShape[];
  missingShapeIds: string[];
};

export function parseImportPayload(
  parsed: unknown,
  registry: CustomGridShape[]
): ParseImportResult | null {
  if (isLoaderExportBundle(parsed)) {
    const shapesToMerge = parsed.customShapes ?? [];
    const registryIds = new Set(registry.map((s) => s.id));
    const mergedShapes = [
      ...registry,
      ...shapesToMerge.filter((s) => !registryIds.has(s.id)),
    ];
    const mergedIds = new Set(mergedShapes.map((s) => s.id));
    const missingShapeIds = collectReferencedShapeIds(parsed.definition).filter(
      (id) => !mergedIds.has(id)
    );
    return {
      definition: parsed.definition,
      shapesToMerge,
      missingShapeIds,
    };
  }

  if (isLoaderDefinition(parsed)) {
    const registryIds = new Set(registry.map((s) => s.id));
    const missingShapeIds = collectReferencedShapeIds(parsed).filter(
      (id) => !registryIds.has(id)
    );
    return {
      definition: parsed,
      shapesToMerge: [],
      missingShapeIds,
    };
  }

  return null;
}

export function totalRegistrySize(shapes: CustomGridShape[]): number {
  return shapes.reduce((sum, s) => sum + shapePayloadSize(s), 0);
}

export function definitionReferencesShape(
  definition: LoaderDefinition,
  shapeId: string
): boolean {
  return definition.states.some((s) => s.grid?.customShapeId === shapeId);
}
