"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_LOADER_UNIT_COLOR,
  normalizeHexColor,
  resolveUnitColor,
} from "@/lib/loaders/color";

type LoaderUnitColorPickerProps = {
  value?: string;
  onChange: (color: string) => void;
  disabled?: boolean;
};

export function LoaderUnitColorPicker({
  value,
  onChange,
  disabled,
}: LoaderUnitColorPickerProps) {
  const resolved = resolveUnitColor(value);
  const [open, setOpen] = useState(false);
  const [hexInput, setHexInput] = useState(resolved);

  useEffect(() => {
    setHexInput(resolved);
  }, [resolved]);

  const commitHex = (raw: string) => {
    const normalized = normalizeHexColor(raw);
    if (normalized) {
      onChange(normalized);
      setHexInput(normalized);
      return true;
    }
    setHexInput(resolved);
    return false;
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    const normalized = normalizeHexColor(pasted);
    if (!normalized) return;

    event.preventDefault();
    onChange(normalized);
    setHexInput(normalized);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-8 w-full justify-start gap-2 px-2 font-normal"
          disabled={disabled}
        >
          <span
            className="size-4 shrink-0 rounded border border-border"
            style={{ backgroundColor: resolved }}
            aria-hidden
          />
          <span className="truncate font-mono text-xs">{resolved}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 p-3">
        <div className="space-y-2">
          <Label className="text-xs">Color</Label>
          <input
            type="color"
            value={resolved}
            disabled={disabled}
            onChange={(event) => {
              const normalized =
                normalizeHexColor(event.target.value) ?? DEFAULT_LOADER_UNIT_COLOR;
              onChange(normalized);
              setHexInput(normalized);
            }}
            className="h-9 w-full cursor-pointer rounded border border-border bg-transparent p-0.5"
            aria-label="Pick color"
          />
          <Input
            value={hexInput}
            disabled={disabled}
            onChange={(event) => setHexInput(event.target.value)}
            onPaste={handlePaste}
            onBlur={() => {
              commitHex(hexInput);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (commitHex(hexInput)) setOpen(false);
              }
            }}
            placeholder="#ffffff"
            className="h-8 font-mono text-xs"
            spellCheck={false}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
