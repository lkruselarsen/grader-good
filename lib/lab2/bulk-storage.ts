import { migrateLegacyHalationKeys, type LookParams as LookParamsT } from "@/lib/look-params";
import { BULK_ITEM_SETTINGS_PREFIX } from "./constants";
import type { PreviewRenderer } from "./preview-mode";
import type { ActiveMatchSelection, Lab2TileBlend } from "./types";

export type BulkItemSettings = {
  lookParams: LookParamsT;
  liveLookParams: LookParamsT;
  activeMatch: ActiveMatchSelection;
  model2Strength: number;
  model2Robust: boolean;
  liveRerenderEnabled?: boolean;
  /** Include actuance in exports. */
  exportActuance?: boolean;
  /** Effects card toggle (highlight warmth + halation). */
  effectsEnabled?: boolean;
  previewRenderer?: PreviewRenderer;
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
    const parsed = JSON.parse(raw) as BulkItemSettings & {
      exportHalationActuance?: boolean;
    };
    if (parsed.exportActuance == null && parsed.exportHalationActuance != null) {
      parsed.exportActuance = parsed.exportHalationActuance;
    }
    delete parsed.exportHalationActuance;
    for (const key of ["lookParams", "liveLookParams"] as const) {
      const lp = parsed[key];
      if (lp?.match) parsed[key] = { ...lp, match: migrateLegacyHalationKeys(lp.match) };
    }
    return parsed;
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
