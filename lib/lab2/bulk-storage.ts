import type { LookParams as LookParamsT } from "@/lib/look-params";
import { BULK_ITEM_SETTINGS_PREFIX } from "./constants";
import type { ActiveMatchSelection, Lab2TileBlend } from "./types";

export type BulkItemSettings = {
  lookParams: LookParamsT;
  liveLookParams: LookParamsT;
  activeMatch: ActiveMatchSelection;
  model2Strength: number;
  model2Robust: boolean;
  liveRerenderEnabled?: boolean;
  halationPreviewEnabled?: boolean;
  exportHalationActuance?: boolean;
  tileBlend?: Lab2TileBlend;
  sourceDecodeRd1?: boolean;
};

function storageKey(id: string): string {
  return `${BULK_ITEM_SETTINGS_PREFIX}${id}`;
}

export function loadBulkItemSettings(id: string): BulkItemSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as BulkItemSettings;
  } catch {
    return null;
  }
}

export function saveBulkItemSettings(
  id: string,
  settings: BulkItemSettings
): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(settings));
  } catch {
    /* ignore quota errors */
  }
}

export function removeBulkItemSettings(id: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(storageKey(id));
  } catch {
    /* ignore */
  }
}
