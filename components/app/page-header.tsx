"use client";

import { usePathname } from "next/navigation";
import { Star } from "lucide-react";
import { useFavorites } from "@/hooks/use-favorites";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  description?: string;
  href?: string;
  className?: string;
};

export function PageHeader({
  title,
  description,
  href,
  className,
}: PageHeaderProps) {
  const pathname = usePathname();
  const favoriteHref = href ?? pathname;
  const { isFavorite, toggleFavorite } = useFavorites();
  const starred = isFavorite(favoriteHref);

  return (
    <div className={cn("mb-6 flex items-start justify-between gap-4", className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-label={starred ? "Remove from favourites" : "Add to favourites"}
        aria-pressed={starred}
        onClick={() => toggleFavorite(favoriteHref)}
      >
        <Star
          className={cn(
            "size-5",
            starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground"
          )}
        />
      </Button>
    </div>
  );
}
