import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type DesignSystemSectionProps = {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
};

export function DesignSystemSection({
  id,
  title,
  description,
  children,
  className,
}: DesignSystemSectionProps) {
  return (
    <section id={id} className={cn("scroll-mt-24 space-y-6", className)}>
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function ShowcasePanel({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="space-y-3">
      {title ? <h3 className="text-sm font-medium">{title}</h3> : null}
      <div
        className={cn(
          "rounded-lg border bg-card p-4 md:p-6",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
