"use client";

import { useCallback, useRef } from "react";
import { Contrast } from "lucide-react";
import { cn } from "@/lib/utils";

/** HSV wheel order, clockwise from the top (red at 0°). */
const HUE_RING =
  "conic-gradient(from 0deg, #ff3b3b, #ffd43b, #5cff3b, #3bffd4, #3b6bff, #c43bff, #ff3b3b)";
/** Fine-adjust factor while Shift is held. */
const FINE_FACTOR = 0.25;

export type HueSatWheelProps = {
  /** Hue in degrees (HSV convention: 0 = red, 60 = yellow). */
  hue: number;
  /** 0..1, distance of the handle from the centre. */
  amount: number;
  onChange: (hue: number, amount: number) => void;
  /** Values restored by the reset button and double-click. */
  defaultHue?: number;
  defaultAmount?: number;
  size?: number;
  dimmed?: boolean;
  className?: string;
  onPointerDown?: () => void;
};

function normHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

function polarToXY(hue: number, amount: number): { x: number; y: number } {
  const t = (hue * Math.PI) / 180;
  return { x: amount * Math.sin(t), y: -amount * Math.cos(t) };
}

function xyToPolar(x: number, y: number): { hue: number; amount: number } {
  const amount = Math.min(1, Math.hypot(x, y));
  const hue = normHue((Math.atan2(x, -y) * 180) / Math.PI);
  return { hue, amount };
}

export function HueSatWheel({
  hue,
  amount,
  onChange,
  defaultHue = 35,
  defaultAmount = 0,
  size = 184,
  dimmed = false,
  className,
  onPointerDown,
}: HueSatWheelProps) {
  const discRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ lastRaw: { x: number; y: number }; pos: { x: number; y: number } } | null>(
    null
  );

  const rawFromEvent = useCallback((clientX: number, clientY: number) => {
    const el = discRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const r = rect.width / 2;
    return {
      x: (clientX - (rect.left + r)) / r,
      y: (clientY - (rect.top + r)) / r,
    };
  }, []);

  const emit = useCallback(
    (x: number, y: number) => {
      const p = xyToPolar(x, y);
      onChange(Math.round(p.hue * 10) / 10, Math.round(p.amount * 1000) / 1000);
    },
    [onChange]
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    onPointerDown?.();
    e.currentTarget.setPointerCapture(e.pointerId);
    const raw = rawFromEvent(e.clientX, e.clientY);
    const pos = e.shiftKey ? polarToXY(hue, amount) : raw;
    dragRef.current = { lastRaw: raw, pos };
    if (!e.shiftKey) emit(raw.x, raw.y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const raw = rawFromEvent(e.clientX, e.clientY);
    const k = e.shiftKey ? FINE_FACTOR : 1;
    let x = drag.pos.x + (raw.x - drag.lastRaw.x) * k;
    let y = drag.pos.y + (raw.y - drag.lastRaw.y) * k;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    drag.lastRaw = raw;
    drag.pos = { x, y };
    emit(x, y);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const reset = () => onChange(defaultHue, defaultAmount);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = (big ? 10 : 1) * (e.key === "ArrowRight" ? 1 : -1);
      onChange(normHue(hue + d), amount);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const d = (big ? 0.05 : 0.01) * (e.key === "ArrowUp" ? 1 : -1);
      onChange(hue, Math.max(0, Math.min(1, Math.round((amount + d) * 1000) / 1000)));
    } else if (e.key === "Home") {
      e.preventDefault();
      reset();
    }
  };

  const handle = polarToXY(hue, amount);
  const handleSize = 22;

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 transition-opacity",
        dimmed && "opacity-50",
        className
      )}
    >
      <div className="flex items-center overflow-hidden rounded-full border border-white/5 bg-white/[0.04] text-sm tabular-nums text-muted-foreground">
        <button
          type="button"
          aria-label="Reset highlight warmth"
          title="Reset"
          onClick={reset}
          className="flex h-8 w-9 items-center justify-center border-r border-white/5 bg-white/[0.04] hover:bg-white/10 hover:text-foreground"
        >
          <Contrast className="size-4" />
        </button>
        <span className="px-3">
          H:&nbsp;&nbsp;{Math.round(hue)}°&nbsp;&nbsp;&nbsp;S:&nbsp;&nbsp;{Math.round(amount * 100)}%
        </span>
      </div>
      <div
        ref={discRef}
        role="slider"
        tabIndex={0}
        aria-label="Highlight warmth hue and strength"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(amount * 100)}
        aria-valuetext={`Hue ${Math.round(hue)} degrees, strength ${Math.round(amount * 100)} percent`}
        className="relative touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        style={{ width: size, height: size }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={reset}
        onKeyDown={handleKeyDown}
      >
        <div className="absolute inset-0 rounded-full" style={{ background: HUE_RING }} />
        <div className="absolute inset-[3px] overflow-hidden rounded-full bg-[#1d1d21]">
          <div
            className="absolute inset-0"
            style={{ background: HUE_RING, filter: "saturate(0.55) brightness(0.32)" }}
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(circle, rgba(29,29,33,0.55) 0%, rgba(29,29,33,0.2) 70%, rgba(29,29,33,0) 100%)",
            }}
          />
        </div>
        <div
          className="pointer-events-none absolute rounded-full bg-[#e6e6ea] shadow-[0_1px_4px_rgba(0,0,0,0.5)]"
          style={{
            width: handleSize,
            height: handleSize,
            left: `calc(${50 + handle.x * 50 * ((size - 6) / size)}% - ${handleSize / 2}px)`,
            top: `calc(${50 + handle.y * 50 * ((size - 6) / size)}% - ${handleSize / 2}px)`,
          }}
        />
      </div>
    </div>
  );
}
