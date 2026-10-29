import type { GrainExportParams } from "@/lib/grain/types";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import type { Lab2TileBlend } from "@/lib/lab2/types";

export const CLOUD_DNG_BUCKET = "cloud-dngs";
export const CLOUD_EXPORT_BUCKET = "cloud-exports";

export const CLOUD_MAX_FILES = 36;
export const CLOUD_MAX_ALGORITHMS = 3;
export const CLOUD_EXPORT_SCALES = [1, 0.7, 0.5] as const;
export type CloudExportScale = (typeof CLOUD_EXPORT_SCALES)[number];

/** Short algorithm codes used in output file names. */
export const CLOUD_ALGORITHM_CODES: Record<Lab2TileBlend, string> = {
  semantic: "STD",
  tonalHeavy: "1090",
  halfHalf: "5050",
};

/** Everything the cloud needs to render a batch exactly like a lab2 export. */
export type CloudRenderSettings = {
  lookParams: LookParamsT;
  effectsEnabled: boolean;
  exportActuance: boolean;
  model2Strength: number;
  model2Robust: boolean;
  withGrain: boolean;
  grain: GrainExportParams;
  exportScale: CloudExportScale;
};

export type CloudJobSettings = CloudRenderSettings & {
  algorithms: Lab2TileBlend[];
};

export type CloudJobStatus = "uploading" | "processing" | "done" | "partial" | "failed";
export type CloudItemStatus = "pending" | "uploaded" | "processing" | "done" | "failed";
export type CloudOutputStatus = "pending" | "processing" | "done" | "failed";
export type CloudEditStatus = "pending" | "processing" | "ready" | "failed";

export type CloudOutputView = {
  id: string;
  itemId: string;
  algorithm: Lab2TileBlend;
  version: number;
  name: string;
  status: CloudOutputStatus;
  error: string | null;
  width: number | null;
  height: number | null;
  sampleName: string | null;
  thumbUrl: string | null;
  pngUrl: string | null;
  downloadUrl: string | null;
  canEdit: boolean;
};

export type CloudItemView = {
  id: string;
  idx: number;
  originalFilename: string;
  status: CloudItemStatus;
  error: string | null;
  hasDng: boolean;
};

export type CloudJobView = {
  slug: string;
  status: CloudJobStatus;
  createdAt: string;
  settings: CloudJobSettings;
  items: CloudItemView[];
  outputs: CloudOutputView[];
};

export type CloudStorageUsage = {
  dngBytes: number;
  exportBytes: number;
  usedBytes: number;
  quotaBytes: number;
};
