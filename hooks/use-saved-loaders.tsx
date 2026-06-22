"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { LoaderExportBundle } from "@/lib/loaders/custom-shapes/bundle";
import {
  createSavedLoaderPreset,
  isSavedLoaderPreset,
  SAVED_LOADERS_STORAGE_KEY,
  type SavedLoaderPreset,
} from "@/lib/loaders/saved-presets";

const STORAGE_EVENT = "grader-good:saved-loaders-changed";

type SavedLoadersContextValue = {
  presets: SavedLoaderPreset[];
  savePreset: (
    bundle: LoaderExportBundle,
    name?: string
  ) => { ok: true; preset: SavedLoaderPreset } | { ok: false; error: string };
  removePreset: (id: string) => void;
  getPreset: (id: string) => SavedLoaderPreset | undefined;
};

const SavedLoadersContext = createContext<SavedLoadersContextValue | null>(null);

const EMPTY_PRESETS: SavedLoaderPreset[] = [];

let cachedRaw: string | null = null;
let cachedSnapshot: SavedLoaderPreset[] = EMPTY_PRESETS;

function readPresets(): SavedLoaderPreset[] {
  if (typeof window === "undefined") return EMPTY_PRESETS;
  try {
    const raw = window.localStorage.getItem(SAVED_LOADERS_STORAGE_KEY);
    if (raw === cachedRaw) return cachedSnapshot;

    cachedRaw = raw;
    if (!raw) {
      cachedSnapshot = EMPTY_PRESETS;
      return cachedSnapshot;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      cachedSnapshot = EMPTY_PRESETS;
      return cachedSnapshot;
    }

    const presets = parsed.filter(isSavedLoaderPreset);
    cachedSnapshot = presets.length > 0 ? presets : EMPTY_PRESETS;
    return cachedSnapshot;
  } catch {
    cachedRaw = null;
    cachedSnapshot = EMPTY_PRESETS;
    return cachedSnapshot;
  }
}

function writePresets(presets: SavedLoaderPreset[]) {
  const raw = JSON.stringify(presets);
  window.localStorage.setItem(SAVED_LOADERS_STORAGE_KEY, raw);
  cachedRaw = raw;
  cachedSnapshot = presets.length > 0 ? presets : EMPTY_PRESETS;
  window.dispatchEvent(new Event(STORAGE_EVENT));
}

function subscribe(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SAVED_LOADERS_STORAGE_KEY) {
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
  return EMPTY_PRESETS;
}

function useSavedLoadersStore() {
  return useSyncExternalStore(subscribe, readPresets, getServerSnapshot);
}

export function SavedLoadersProvider({ children }: { children: ReactNode }) {
  const presets = useSavedLoadersStore();

  const savePreset = useCallback((bundle: LoaderExportBundle, name?: string) => {
    try {
      const preset = createSavedLoaderPreset(bundle, name);
      const current = readPresets();
      writePresets([preset, ...current]);
      return { ok: true as const, preset };
    } catch {
      return { ok: false as const, error: "Could not save preset — storage may be full" };
    }
  }, []);

  const removePreset = useCallback((id: string) => {
    const current = readPresets();
    writePresets(current.filter((p) => p.id !== id));
  }, []);

  const getPreset = useCallback(
    (id: string) => presets.find((p) => p.id === id),
    [presets]
  );

  const value = useMemo(
    () => ({ presets, savePreset, removePreset, getPreset }),
    [presets, savePreset, removePreset, getPreset]
  );

  return (
    <SavedLoadersContext.Provider value={value}>
      {children}
    </SavedLoadersContext.Provider>
  );
}

export function useSavedLoaders() {
  const context = useContext(SavedLoadersContext);
  if (!context) {
    throw new Error("useSavedLoaders must be used within a SavedLoadersProvider");
  }
  return context;
}

export function useSavedLoadersOptional() {
  return useContext(SavedLoadersContext);
}
