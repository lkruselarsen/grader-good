"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import type { FineGrainStrength, GrainExportParams } from "@/lib/grain/types";

/** Grain export controls shared by the export dialog and the cloud batch sheet. */
export function GrainFields({
  params,
  disabled = false,
  idPrefix = "grain",
  onChange,
}: {
  params: GrainExportParams;
  disabled?: boolean;
  idPrefix?: string;
  onChange: (patch: Partial<GrainExportParams>) => void;
}) {
  return (
    <div className="space-y-4 py-2">
      <div className="flex items-center gap-3">
        <Checkbox
          id={`${idPrefix}-fine-grain-enabled`}
          checked={params.fineGrainEnabled}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ fineGrainEnabled: checked === true })}
        />
        <Label htmlFor={`${idPrefix}-fine-grain-enabled`} className="flex-1 cursor-pointer">
          Fine grain
        </Label>
        <div className="flex gap-1">
          {(["normal", "strong"] as const).map((strength) => (
            <Button
              key={strength}
              type="button"
              variant={params.fineGrainStrength === strength ? "default" : "outline"}
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={!params.fineGrainEnabled || disabled}
              onClick={() => onChange({ fineGrainStrength: strength as FineGrainStrength })}
            >
              {strength === "normal" ? "Normal" : "Strong"}
            </Button>
          ))}
        </div>
      </div>

      {params.fineGrainEnabled && (
        <div className="flex items-center gap-3 pl-7">
          <Checkbox
            id={`${idPrefix}-fine-grain-extra-chroma`}
            checked={params.fineGrainExtraChroma}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ fineGrainExtraChroma: checked === true })}
          />
          <Label
            htmlFor={`${idPrefix}-fine-grain-extra-chroma`}
            className="cursor-pointer text-sm text-muted-foreground"
          >
            Extra chroma
          </Label>
        </div>
      )}

      <div className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${idPrefix}-pointillist-opacity-magnitude`} className="text-sm">
            Pointillist grain magnitude
          </Label>
          <span className="text-xs tabular-nums text-muted-foreground">
            {params.pointillistOpacityMagnitude.toFixed(2)}
          </span>
        </div>
        <Slider
          id={`${idPrefix}-pointillist-opacity-magnitude`}
          min={0}
          max={1}
          step={0.01}
          disabled={disabled}
          value={[params.pointillistOpacityMagnitude]}
          onValueChange={(v) =>
            onChange({
              pointillistOpacityMagnitude: v[0] ?? params.pointillistOpacityMagnitude,
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          Scales all exposure-zone opacities (1.0 = default)
        </p>
      </div>
    </div>
  );
}
