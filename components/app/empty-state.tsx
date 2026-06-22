import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  variant?: "default" | "error";
  className?: string;
};

export function EmptyState({
  title,
  description,
  action,
  variant = "default",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center",
        variant === "error" && "border-destructive/50 bg-destructive/5",
        className
      )}
    >
      <p
        className={cn(
          "text-sm font-medium",
          variant === "error" ? "text-destructive" : "text-foreground"
        )}
      >
        {title}
      </p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
