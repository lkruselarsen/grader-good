"use client";

import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { Lab2Section } from "./lab2-look-sections";

/**
 * Mobile controls: one section per slide, swiped horizontally with scroll-snap.
 * Slides scroll vertically on their own; nothing inside a slide scrolls sideways.
 */
export function Lab2ControlsCarousel({
  sections,
  beginDrag,
  className,
}: {
  sections: Lab2Section[];
  beginDrag: (cost: "expensive" | "normal") => void;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const onScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track || track.clientWidth === 0) return;
    const idx = Math.round(track.scrollLeft / track.clientWidth);
    setActive((prev) => (prev === idx ? prev : idx));
  }, []);

  const goTo = useCallback((idx: number) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollTo({ left: idx * track.clientWidth, behavior: "smooth" });
  }, []);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border bg-sidebar text-sidebar-foreground",
        className
      )}
    >
      <div className="flex shrink-0 items-center justify-center gap-0.5 pt-1.5" role="tablist">
        {sections.map((section, idx) => (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={idx === active}
            aria-label={section.title}
            className="p-1.5 touch-manipulation"
            onClick={() => goTo(idx)}
          >
            <span
              className={cn(
                "block size-1.5 rounded-full transition-colors",
                idx === active ? "bg-foreground" : "bg-muted-foreground/40"
              )}
            />
          </button>
        ))}
      </div>
      <div
        ref={trackRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {sections.map((section) => {
          const cost = section.expensive ? "expensive" : "normal";
          return (
            <section
              key={section.id}
              aria-label={section.title}
              className="relative h-full w-full shrink-0 basis-full snap-start snap-always overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-1"
              onPointerDownCapture={() => beginDrag(cost)}
              onTouchStart={() => beginDrag(cost)}
            >
              {!section.headerless && (
                <h2 className="py-2 text-sm font-medium text-muted-foreground">
                  {section.title}
                </h2>
              )}
              <div className="space-y-3">{section.content}</div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
