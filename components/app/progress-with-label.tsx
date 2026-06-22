import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type ProgressWithLabelProps = {
  value?: number;
  label: string;
  indeterminate?: boolean;
  className?: string;
};

export function ProgressWithLabel({
  value,
  label,
  indeterminate = false,
  className,
}: ProgressWithLabelProps) {
  return (
    <div className={cn("space-y-1", className)}>
      {indeterminate ? (
        <div className="h-2 w-full overflow-hidden rounded-full bg-primary/20">
          <div className="h-full w-full min-w-[30%] animate-pulse bg-primary" />
        </div>
      ) : (
        <Progress value={value} className="h-2" />
      )}
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
