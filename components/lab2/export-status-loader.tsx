"use client";

import { memo, useEffect, useRef, useState } from "react";
import { RotatingSavedLoaders } from "@/components/loaders/rotating-saved-loaders";

type ExportStatusLoaderProps = {
  label: string;
  className?: string;
};

/** Export modal loader — rotates through the export playlist when the stage label changes. */
export const ExportStatusLoader = memo(function ExportStatusLoader({
  label,
  className,
}: ExportStatusLoaderProps) {
  const [presetIndex, setPresetIndex] = useState(0);
  const prevLabelRef = useRef(label);

  useEffect(() => {
    if (prevLabelRef.current !== label) {
      setPresetIndex((index) => index + 1);
      prevLabelRef.current = label;
    }
  }, [label]);

  return (
    <RotatingSavedLoaders
      loopId="export"
      label={label}
      className={className}
      presetIndex={presetIndex}
    />
  );
});
