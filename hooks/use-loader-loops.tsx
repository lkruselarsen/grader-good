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
  EMPTY_LOADER_LOOPS,
  isInLoop as isInLoopConfig,
  isLoaderLoopsConfig,
  LOADER_LOOPS_STORAGE_KEY,
  setLoopMembership,
  type LoaderLoopId,
  type LoaderLoopsConfig,
} from "@/lib/loaders/loops";

const STORAGE_EVENT = "grader-good:loader-loops-changed";

type LoaderLoopsContextValue = {
  config: LoaderLoopsConfig;
  isInLoop: (loopId: LoaderLoopId, presetId: string) => boolean;
  setMembership: (
    loopId: LoaderLoopId,
    presetId: string,
    include: boolean
  ) => void;
};

const LoaderLoopsContext = createContext<LoaderLoopsContextValue | null>(null);

let cachedRaw: string | null = null;
let cachedSnapshot: LoaderLoopsConfig = EMPTY_LOADER_LOOPS;

function readConfig(): LoaderLoopsConfig {
  if (typeof window === "undefined") return EMPTY_LOADER_LOOPS;
  try {
    const raw = window.localStorage.getItem(LOADER_LOOPS_STORAGE_KEY);
    if (raw === cachedRaw) return cachedSnapshot;

    cachedRaw = raw;
    if (!raw) {
      cachedSnapshot = EMPTY_LOADER_LOOPS;
      return cachedSnapshot;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isLoaderLoopsConfig(parsed)) {
      cachedSnapshot = EMPTY_LOADER_LOOPS;
      return cachedSnapshot;
    }

    cachedSnapshot = parsed;
    return cachedSnapshot;
  } catch {
    cachedRaw = null;
    cachedSnapshot = EMPTY_LOADER_LOOPS;
    return cachedSnapshot;
  }
}

function writeConfig(config: LoaderLoopsConfig) {
  const raw = JSON.stringify(config);
  window.localStorage.setItem(LOADER_LOOPS_STORAGE_KEY, raw);
  cachedRaw = raw;
  cachedSnapshot = config;
  window.dispatchEvent(new Event(STORAGE_EVENT));
}

function subscribe(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOADER_LOOPS_STORAGE_KEY) {
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
  return EMPTY_LOADER_LOOPS;
}

function useLoaderLoopsStore() {
  return useSyncExternalStore(subscribe, readConfig, getServerSnapshot);
}

export function LoaderLoopsProvider({ children }: { children: ReactNode }) {
  const config = useLoaderLoopsStore();

  const setMembership = useCallback(
    (loopId: LoaderLoopId, presetId: string, include: boolean) => {
      const current = readConfig();
      writeConfig(setLoopMembership(current, loopId, presetId, include));
    },
    []
  );

  const isInLoop = useCallback(
    (loopId: LoaderLoopId, presetId: string) =>
      isInLoopConfig(config, loopId, presetId),
    [config]
  );

  const value = useMemo(
    () => ({ config, isInLoop, setMembership }),
    [config, isInLoop, setMembership]
  );

  return (
    <LoaderLoopsContext.Provider value={value}>
      {children}
    </LoaderLoopsContext.Provider>
  );
}

export function useLoaderLoops() {
  const context = useContext(LoaderLoopsContext);
  if (!context) {
    throw new Error("useLoaderLoops must be used within a LoaderLoopsProvider");
  }
  return context;
}

export function useLoaderLoopsOptional() {
  return useContext(LoaderLoopsContext);
}
