import { toast } from "sonner";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import {
  cloneLab2LookParams,
  LAB2_DEFAULT_LOOK_PARAMS,
  LAB2_DEFAULTS_STORAGE_KEY,
} from "./constants";

export type Lab2DefaultsUndoSnapshot = {
  lookParams: LookParamsT;
  savedDefaultsRaw: string | null;
};

const RESET_TOAST_ID = "lab2-reset-defaults";

export function captureLab2DefaultsUndoSnapshot(
  lookParams: LookParamsT
): Lab2DefaultsUndoSnapshot {
  let savedDefaultsRaw: string | null = null;
  try {
    savedDefaultsRaw = localStorage.getItem(LAB2_DEFAULTS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return {
    lookParams: cloneLab2LookParams(lookParams),
    savedDefaultsRaw,
  };
}

export function restoreLab2DefaultsLocalStorage(
  snapshot: Lab2DefaultsUndoSnapshot
): void {
  try {
    if (snapshot.savedDefaultsRaw !== null) {
      localStorage.setItem(LAB2_DEFAULTS_STORAGE_KEY, snapshot.savedDefaultsRaw);
    } else {
      localStorage.removeItem(LAB2_DEFAULTS_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

function clearLab2SavedDefaults(): void {
  try {
    localStorage.removeItem(LAB2_DEFAULTS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function showLab2ResetUndoToast(onUndo: () => void): void {
  toast.dismiss(RESET_TOAST_ID);
  toast("Reset to Lab2 baseline defaults", {
    id: RESET_TOAST_ID,
    description: "Your previous settings can be restored.",
    duration: 12_000,
    closeButton: true,
    action: {
      label: "Undo",
      onClick: onUndo,
    },
  });
}

/** Reset look params to Lab2 baseline and show an undo toast. */
export function applyLab2ResetWithUndo(options: {
  currentLookParams: LookParamsT;
  applyReset: (reset: LookParamsT) => void;
  applyUndo: (snapshot: Lab2DefaultsUndoSnapshot) => void;
}): void {
  const snapshot = captureLab2DefaultsUndoSnapshot(options.currentLookParams);
  const reset = cloneLab2LookParams(LAB2_DEFAULT_LOOK_PARAMS);
  clearLab2SavedDefaults();
  options.applyReset(reset);
  showLab2ResetUndoToast(() => {
    restoreLab2DefaultsLocalStorage(snapshot);
    options.applyUndo(snapshot);
    toast.dismiss(RESET_TOAST_ID);
  });
}
