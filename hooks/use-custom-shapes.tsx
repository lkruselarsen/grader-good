"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  CUSTOM_SHAPE_LIMITS,
  shapePayloadSize,
  type CustomGridShape,
} from "@/lib/loaders/custom-shapes/types";
import { totalRegistrySize } from "@/lib/loaders/custom-shapes/bundle";

const STORAGE_KEY = "grader-good:loader-custom-shapes";
const STORAGE_EVENT = "grader-good:loader-custom-shapes-changed";

type CustomShapesContextValue = {
  shapes: CustomGridShape[];
  shapesMap: Record<string, CustomGridShape>;
  addShape: (shape: CustomGridShape) => { ok: true } | { ok: false; error: string };
  removeShape: (id: string) => void;
  getShape: (id: string) => CustomGridShape | undefined;
  mergeShapes: (incoming: CustomGridShape[]) => { merged: number; skipped: number };
};

const CustomShapesContext = createContext<CustomShapesContextValue | null>(null);

const EMPTY_SHAPES: CustomGridShape[] = [];

let cachedRaw: string | null = null;
let cachedSnapshot: CustomGridShape[] = EMPTY_SHAPES;

function readShapes(): CustomGridShape[] {
  if (typeof window === "undefined") return EMPTY_SHAPES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedSnapshot;

    cachedRaw = raw;
    if (!raw) {
      cachedSnapshot = EMPTY_SHAPES;
      return cachedSnapshot;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      cachedSnapshot = EMPTY_SHAPES;
      return cachedSnapshot;
    }

    const shapes = parsed.filter(
      (s): s is CustomGridShape =>
        s != null &&
        typeof s === "object" &&
        typeof (s as CustomGridShape).id === "string" &&
        typeof (s as CustomGridShape).name === "string" &&
        ((s as CustomGridShape).kind === "svg" ||
          (s as CustomGridShape).kind === "png")
    );

    cachedSnapshot = shapes.length > 0 ? shapes : EMPTY_SHAPES;
    return cachedSnapshot;
  } catch {
    cachedRaw = null;
    cachedSnapshot = EMPTY_SHAPES;
    return cachedSnapshot;
  }
}

function writeShapes(shapes: CustomGridShape[]) {
  const raw = JSON.stringify(shapes);
  window.localStorage.setItem(STORAGE_KEY, raw);
  cachedRaw = raw;
  cachedSnapshot = shapes.length > 0 ? shapes : EMPTY_SHAPES;
  window.dispatchEvent(new Event(STORAGE_EVENT));
}

function subscribe(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cachedRaw = null;
      onStoreChange();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(STORAGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(STORAGE_EVENT, onStoreChange);
  };
}

function getServerSnapshot() {
  return EMPTY_SHAPES;
}

function useCustomShapesStore() {
  return useSyncExternalStore(subscribe, readShapes, getServerSnapshot);
}

export function CustomShapesProvider({ children }: { children: ReactNode }) {
  const shapes = useCustomShapesStore();

  const shapesMap = useMemo(
    () => Object.fromEntries(shapes.map((s) => [s.id, s])),
    [shapes]
  );

  const addShape = useCallback((shape: CustomGridShape) => {
    const current = readShapes();
    if (current.some((s) => s.id === shape.id)) {
      return { ok: false as const, error: "A shape with this id already exists" };
    }

    const next = [...current, shape];
    const size = totalRegistrySize(next);
    if (size > CUSTOM_SHAPE_LIMITS.registryMaxBytes) {
      return {
        ok: false as const,
        error: `Registry quota exceeded (max ~${CUSTOM_SHAPE_LIMITS.registryMaxBytes / (1024 * 1024)} MB)`,
      };
    }

    if (shapePayloadSize(shape) > CUSTOM_SHAPE_LIMITS.registryMaxBytes / 4) {
      return { ok: false as const, error: "This shape is too large to store" };
    }

    writeShapes(next);
    return { ok: true as const };
  }, []);

  const removeShape = useCallback((id: string) => {
    const current = readShapes();
    writeShapes(current.filter((s) => s.id !== id));
  }, []);

  const getShape = useCallback(
    (id: string) => shapesMap[id],
    [shapesMap]
  );

  const mergeShapes = useCallback((incoming: CustomGridShape[]) => {
    if (incoming.length === 0) return { merged: 0, skipped: 0 };

    const current = readShapes();
    const ids = new Set(current.map((s) => s.id));
    const toAdd = incoming.filter((s) => !ids.has(s.id));
    if (toAdd.length === 0) return { merged: 0, skipped: 0 };

    let merged = 0;
    let skipped = 0;
    const next = [...current];

    for (const shape of toAdd) {
      const candidate = [...next, shape];
      if (totalRegistrySize(candidate) > CUSTOM_SHAPE_LIMITS.registryMaxBytes) {
        skipped += 1;
        continue;
      }
      next.push(shape);
      merged += 1;
    }

    if (merged > 0) writeShapes(next);
    return { merged, skipped };
  }, []);

  const value = useMemo(
    () => ({ shapes, shapesMap, addShape, removeShape, getShape, mergeShapes }),
    [shapes, shapesMap, addShape, removeShape, getShape, mergeShapes]
  );

  return (
    <CustomShapesContext.Provider value={value}>
      {children}
    </CustomShapesContext.Provider>
  );
}

export function useCustomShapes() {
  const context = useContext(CustomShapesContext);
  if (!context) {
    throw new Error("useCustomShapes must be used within a CustomShapesProvider");
  }
  return context;
}

export function useCustomShapesOptional() {
  return useContext(CustomShapesContext);
}
