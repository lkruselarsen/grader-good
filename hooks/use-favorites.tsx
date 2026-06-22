"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { NAV_ITEMS, type NavItem } from "@/lib/navigation";

const FAVORITES_STORAGE_KEY = "grader-good:favorites";
const FAVORITES_EVENT = "grader-good:favorites-changed";

type FavoritesContextValue = {
  favorites: string[];
  favoriteItems: NavItem[];
  toggleFavorite: (href: string) => void;
  isFavorite: (href: string) => boolean;
};

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

const EMPTY_FAVORITES: string[] = [];

let cachedRaw: string | null = null;
let cachedSnapshot: string[] = EMPTY_FAVORITES;

function readFavorites(): string[] {
  if (typeof window === "undefined") return EMPTY_FAVORITES;
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (raw === cachedRaw) return cachedSnapshot;

    cachedRaw = raw;
    if (!raw) {
      cachedSnapshot = EMPTY_FAVORITES;
      return cachedSnapshot;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      cachedSnapshot = EMPTY_FAVORITES;
      return cachedSnapshot;
    }

    const hrefs = parsed.filter((href): href is string => typeof href === "string");
    cachedSnapshot = hrefs.length > 0 ? hrefs : EMPTY_FAVORITES;
    return cachedSnapshot;
  } catch {
    cachedRaw = null;
    cachedSnapshot = EMPTY_FAVORITES;
    return cachedSnapshot;
  }
}

function writeFavorites(hrefs: string[]) {
  const raw = JSON.stringify(hrefs);
  window.localStorage.setItem(FAVORITES_STORAGE_KEY, raw);
  cachedRaw = raw;
  cachedSnapshot = hrefs.length > 0 ? hrefs : EMPTY_FAVORITES;
  window.dispatchEvent(new Event(FAVORITES_EVENT));
}

function subscribe(onStoreChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === FAVORITES_STORAGE_KEY) {
      cachedRaw = null;
      onStoreChange();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(FAVORITES_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(FAVORITES_EVENT, onStoreChange);
  };
}

function getServerSnapshot() {
  return EMPTY_FAVORITES;
}

function useFavoritesStore() {
  return useSyncExternalStore(subscribe, readFavorites, getServerSnapshot);
}

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const favorites = useFavoritesStore();

  const toggleFavorite = useCallback((href: string) => {
    const current = readFavorites();
    const next = current.includes(href)
      ? current.filter((item) => item !== href)
      : [...current, href];
    writeFavorites(next);
  }, []);

  const isFavorite = useCallback(
    (href: string) => favorites.includes(href),
    [favorites]
  );

  const favoriteItems = useMemo(
    () =>
      favorites
        .map((href) => NAV_ITEMS.find((item) => item.href === href))
        .filter((item): item is NavItem => item != null),
    [favorites]
  );

  const value = useMemo(
    () => ({ favorites, favoriteItems, toggleFavorite, isFavorite }),
    [favorites, favoriteItems, toggleFavorite, isFavorite]
  );

  return (
    <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>
  );
}

export function useFavorites() {
  const context = useContext(FavoritesContext);
  if (!context) {
    throw new Error("useFavorites must be used within a FavoritesProvider");
  }
  return context;
}
