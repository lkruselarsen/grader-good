import type { ColorToken } from "@/lib/design-system/tokens";
import { cn } from "@/lib/utils";

type ColorSwatchProps = {
  token: ColorToken;
  className?: string;
};

export function ColorSwatch({ token, className }: ColorSwatchProps) {
  const isForeground = token.name.includes("foreground");
  const swatchStyle = isForeground
    ? { color: `var(${token.cssVar})` }
    : { backgroundColor: `var(${token.cssVar})` };

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-card",
        className
      )}
    >
      <div
        className={cn(
          "flex h-16 items-center justify-center border-b",
          isForeground ? "bg-background" : "border-transparent"
        )}
        style={swatchStyle}
      >
        {isForeground ? (
          <span className="text-sm font-medium">Aa</span>
        ) : null}
      </div>
      <div className="space-y-0.5 p-3">
        <p className="text-sm font-medium">{token.name}</p>
        <p className="font-mono text-xs text-muted-foreground">{token.cssVar}</p>
        <p className="font-mono text-xs text-muted-foreground">{token.tailwind}</p>
        {token.description ? (
          <p className="text-xs text-muted-foreground">{token.description}</p>
        ) : null}
      </div>
    </div>
  );
}

export function ColorSwatchGrid({ tokens }: { tokens: ColorToken[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {tokens.map((token) => (
        <ColorSwatch key={token.name} token={token} />
      ))}
    </div>
  );
}
