"use client";

import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  defaultColorDensityCurve,
  defaultExposureCurve,
  halationFromLook,
  type LookParams as LookParamsT,
  type LookParamsMatch,
} from "@/lib/look-params";
import { REFRACTION_HUE_NAMES } from "@/lib/lab2/constants";
import { cn } from "@/lib/utils";
import { REFRACTION_POST_MODEL2_HUES_DEG } from "@/src/lib/pipeline/stages/refractionPostModel2";
import { HueSatWheel } from "./hue-sat-wheel";

const SLIDER_CLASS = "w-full touch-manipulation";

export type UpdateLookMatch = <K extends keyof LookParamsT["match"]>(
  key: K,
  value: LookParamsT["match"][K],
  cost?: "expensive" | "normal"
) => void;

/** Look slider sections (masters → actuance); render inside an <Accordion>. */
export function Lab2LookAccordionItems({
  lookParams,
  updateMatch,
  beginDrag,
}: {
  lookParams: LookParamsT;
  updateMatch: UpdateLookMatch;
  beginDrag: (cost: "expensive" | "normal") => void;
}) {
  return (
    <>
      <AccordionItem value="masters">
        <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
          Masters
        </AccordionTrigger>
        <AccordionContent
          className="space-y-3"
          onPointerDownCapture={() => beginDrag("expensive")}
          onTouchStart={() => beginDrag("expensive")}
        >
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Overall exposure (× all 7 handles)</span>
              <span>{(lookParams.match.exposureCurveMasterMul ?? 1).toFixed(2)}</span>
            </div>
            <Slider
              className={SLIDER_CLASS}
              min={0.25}
              max={4}
              step={0.01}
              value={[lookParams.match.exposureCurveMasterMul ?? 1]}
              onValueChange={(v) =>
                updateMatch("exposureCurveMasterMul", v[0] ?? 1, "expensive")
              }
            />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Overall colour density (× all 7)</span>
              <span>{(lookParams.match.colorDensityCurveMasterMul ?? 1).toFixed(2)}</span>
            </div>
            <Slider
              className={SLIDER_CLASS}
              min={0.25}
              max={4}
              step={0.01}
              value={[lookParams.match.colorDensityCurveMasterMul ?? 1]}
              onValueChange={(v) =>
                updateMatch("colorDensityCurveMasterMul", v[0] ?? 1, "expensive")
              }
            />
          </div>
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="exposure">
        <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
          Exposure handles
        </AccordionTrigger>
        <AccordionContent
          className="space-y-3"
          onPointerDownCapture={() => beginDrag("expensive")}
          onTouchStart={() => beginDrag("expensive")}
        >
          {(lookParams.match.exposureCurve ?? defaultExposureCurve()).L_out.map(
            (_, idx) => {
              const curve = lookParams.match.exposureCurve ?? defaultExposureCurve();
              const L_out = [...curve.L_out];
              return (
                <div key={idx} className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Handle {idx + 1}</span>
                    <span>{L_out[idx]?.toFixed(2) ?? "1"}</span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0}
                    max={2}
                    step={0.01}
                    value={[L_out[idx] ?? 1]}
                    onValueChange={(v) => {
                      const next = [...L_out];
                      next[idx] = v[0] ?? 1;
                      updateMatch(
                        "exposureCurve",
                        { ...curve, L_out: next },
                        "expensive"
                      );
                    }}
                  />
                </div>
              );
            }
          )}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="color-density">
        <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
          Colour density
        </AccordionTrigger>
        <AccordionContent
          className="space-y-3"
          onPointerDownCapture={() => beginDrag("expensive")}
          onTouchStart={() => beginDrag("expensive")}
        >
          {(lookParams.match.colorDensityCurve ?? defaultColorDensityCurve()).scale.map(
            (_, idx) => {
              const cur =
                lookParams.match.colorDensityCurve ?? defaultColorDensityCurve();
              const scale = [...cur.scale];
              return (
                <div key={idx} className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Handle {idx + 1}</span>
                    <span>{scale[idx]?.toFixed(2) ?? "1"}</span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0.2}
                    max={2.5}
                    step={0.01}
                    value={[scale[idx] ?? 1]}
                    onValueChange={(v) => {
                      const next = [...scale];
                      next[idx] = v[0] ?? 1;
                      updateMatch(
                        "colorDensityCurve",
                        { ...cur, scale: next },
                        "expensive"
                      );
                    }}
                  />
                </div>
              );
            }
          )}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="refraction">
        <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
          Refraction post–M2 (12 × sat)
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Hues fixed every 30°. Only saturation is adjustable.
          </p>
          {(lookParams.match.refractionPostModel2 ?? Array(12).fill(1)).map(
            (sat, idx) => (
              <div key={idx} className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {REFRACTION_POST_MODEL2_HUES_DEG[idx]}° ({REFRACTION_HUE_NAMES[idx]})
                  </span>
                  <span>{sat.toFixed(2)}</span>
                </div>
                <Slider
                  className={SLIDER_CLASS}
                  min={0}
                  max={3}
                  step={0.01}
                  value={[sat]}
                  onValueChange={(v) => {
                    const arr = [
                      ...(lookParams.match.refractionPostModel2 ?? Array(12).fill(1)),
                    ];
                    arr[idx] = v[0] ?? 1;
                    updateMatch("refractionPostModel2", arr);
                  }}
                />
              </div>
            )
          )}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="devignette">
        <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
          De-vignette
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Inner diameter / min side</span>
              <span>
                {(lookParams.match.devignette?.innerDiameterNorm ?? 0.65).toFixed(2)}
              </span>
            </div>
            <Slider
              className={SLIDER_CLASS}
              min={0}
              max={1}
              step={0.01}
              value={[lookParams.match.devignette?.innerDiameterNorm ?? 0.65]}
              onValueChange={(v) =>
                updateMatch("devignette", {
                  innerDiameterNorm: v[0] ?? 0.65,
                  strengthStops: lookParams.match.devignette?.strengthStops ?? 0,
                })
              }
            />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Corner lift (stops)</span>
              <span>{(lookParams.match.devignette?.strengthStops ?? 0).toFixed(2)}</span>
            </div>
            <Slider
              className={SLIDER_CLASS}
              min={0}
              max={3}
              step={0.02}
              value={[lookParams.match.devignette?.strengthStops ?? 0]}
              onValueChange={(v) =>
                updateMatch("devignette", {
                  innerDiameterNorm:
                    lookParams.match.devignette?.innerDiameterNorm ?? 0.65,
                  strengthStops: v[0] ?? 0,
                })
              }
            />
          </div>
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="highlights">
        <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
          Highlights post–M2
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Highlight smoothing</span>
              <span>{(lookParams.match.highlightSmoothing ?? 0).toFixed(2)}</span>
            </div>
            <Slider
              className={SLIDER_CLASS}
              min={0}
              max={1}
              step={0.01}
              value={[lookParams.match.highlightSmoothing ?? 0]}
              onValueChange={(v) =>
                updateMatch("highlightSmoothing", v[0] ?? 0)
              }
            />
          </div>
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="actuance">
        <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
          Actuance (apply only)
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Strength</span>
              <span>{(lookParams.match.actuanceStrength ?? 0).toFixed(2)}</span>
            </div>
            <Slider
              className={SLIDER_CLASS}
              min={0}
              max={3}
              step={0.05}
              value={[lookParams.match.actuanceStrength ?? 0]}
              onValueChange={(v) => updateMatch("actuanceStrength", v[0] ?? 0)}
            />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Radius</span>
              <span>{(lookParams.match.actuanceRadius ?? 0).toFixed(2)}</span>
            </div>
            <Slider
              className={SLIDER_CLASS}
              min={0}
              max={5}
              step={0.1}
              value={[lookParams.match.actuanceRadius ?? 0]}
              onValueChange={(v) => updateMatch("actuanceRadius", v[0] ?? 0)}
            />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Highlight guard</span>
              <span>{(lookParams.match.actuanceHighlightGuard ?? 0).toFixed(2)}</span>
            </div>
            <Slider
              className={SLIDER_CLASS}
              min={0}
              max={0.9}
              step={0.01}
              value={[lookParams.match.actuanceHighlightGuard ?? 0]}
              onValueChange={(v) =>
                updateMatch("actuanceHighlightGuard", v[0] ?? 0)
              }
            />
          </div>
        </AccordionContent>
      </AccordionItem>
    </>
  );
}

const DEFAULT_WARMTH_HUE = 35;

export function FinishingEffectsCard({
  lookParams,
  enabled,
  onEnabledChange,
  updateMatch,
}: {
  lookParams: LookParamsT;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  updateMatch: UpdateLookMatch;
}) {
  const m = lookParams.match;
  const hue = m.highlightWarmthHue ?? DEFAULT_WARMTH_HUE;
  const amount = m.highlightWarmthAmount ?? 0;
  const thresholdPct = Math.round((m.highlightWarmthThreshold ?? 0.25) * 100);
  const halation = halationFromLook(m);
  const halationSliders: {
    key: Extract<
      keyof LookParamsMatch,
      "halationAmount" | "halationSensitivity" | "halationRadius" | "halationWarmth"
    >;
    label: string;
    value: number;
    fallback: number;
  }[] = [
    { key: "halationAmount", label: "Amount", value: halation.amount, fallback: 0.35 },
    { key: "halationSensitivity", label: "Sensitivity", value: halation.sensitivity, fallback: 0.5 },
    { key: "halationRadius", label: "Radius", value: halation.radius, fallback: 0.5 },
    { key: "halationWarmth", label: "Warmth", value: halation.warmth, fallback: 0.5 },
  ];
  return (
    <section className="rounded-lg border bg-card/40">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <Label htmlFor="finishing-effects-toggle" className="cursor-pointer text-sm font-medium text-muted-foreground">
          Highlight Warmth + Halation
        </Label>
        <Switch
          id="finishing-effects-toggle"
          checked={enabled}
          onCheckedChange={(checked) => onEnabledChange(checked === true)}
        />
      </div>
      <Separator />
      <div className={cn("space-y-5 p-3 transition-opacity", !enabled && "opacity-50")}>
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground/80">Highlight Warmth</p>
          <HueSatWheel
            hue={hue}
            amount={amount}
            defaultHue={DEFAULT_WARMTH_HUE}
            defaultAmount={0}
            onChange={(h, a) => {
              updateMatch("highlightWarmthHue", h);
              updateMatch("highlightWarmthAmount", a);
            }}
          />
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Threshold</span>
              <span>Top {thresholdPct}%</span>
            </div>
            <Slider
              className={SLIDER_CLASS}
              inverted
              min={1}
              max={50}
              step={1}
              value={[thresholdPct]}
              onValueChange={(v) =>
                updateMatch("highlightWarmthThreshold", (v[0] ?? 25) / 100)
              }
            />
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground/80">Halation</p>
          {halationSliders.map(({ key, label, value, fallback }) => {
            const pct = Math.round(value * 100);
            return (
              <div key={key} className="space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{label}</span>
                  <span>{pct}%</span>
                </div>
                <Slider
                  className={SLIDER_CLASS}
                  min={0}
                  max={100}
                  step={1}
                  value={[pct]}
                  onValueChange={(v) => updateMatch(key, (v[0] ?? fallback * 100) / 100)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
