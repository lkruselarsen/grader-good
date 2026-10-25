"use client";

import { cn } from "@/lib/utils";
import type { PreviewRenderer } from "@/lib/lab2/preview-mode";

const OPTIONS: { value: PreviewRenderer; label: string }[] = [
  { value: "2d", label: "2D" },
  { value: "webgl", label: "WebGL" },
];

export function PreviewRendererToggle({
  value,
  onChange,
  disabled,
  className,
}: {
  value: PreviewRenderer;
  onChange: (value: PreviewRenderer) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Preview renderer"
      className={cn(
        "inline-flex h-9 items-center rounded-md border bg-background p-0.5 text-xs",
        disabled && "pointer-events-none opacity-50",
        className
      )}
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => {
              if (!active) onChange(opt.value);
            }}
            className={cn(
              "h-full rounded-[5px] px-2.5 font-medium transition-colors",
              active
                ? "bg-secondary text-secondary-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
