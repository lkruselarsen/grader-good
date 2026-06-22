export type ColorToken = {
  name: string;
  cssVar: string;
  tailwind: string;
  description?: string;
};

export const SEMANTIC_COLOR_TOKENS: ColorToken[] = [
  { name: "background", cssVar: "--background", tailwind: "bg-background", description: "Page canvas" },
  { name: "foreground", cssVar: "--foreground", tailwind: "text-foreground", description: "Primary text" },
  { name: "card", cssVar: "--card", tailwind: "bg-card", description: "Card surfaces" },
  { name: "card-foreground", cssVar: "--card-foreground", tailwind: "text-card-foreground" },
  { name: "popover", cssVar: "--popover", tailwind: "bg-popover" },
  { name: "popover-foreground", cssVar: "--popover-foreground", tailwind: "text-popover-foreground" },
  { name: "primary", cssVar: "--primary", tailwind: "bg-primary", description: "Primary actions" },
  { name: "primary-foreground", cssVar: "--primary-foreground", tailwind: "text-primary-foreground" },
  { name: "secondary", cssVar: "--secondary", tailwind: "bg-secondary" },
  { name: "secondary-foreground", cssVar: "--secondary-foreground", tailwind: "text-secondary-foreground" },
  { name: "muted", cssVar: "--muted", tailwind: "bg-muted", description: "Subtle backgrounds" },
  { name: "muted-foreground", cssVar: "--muted-foreground", tailwind: "text-muted-foreground", description: "Secondary text" },
  { name: "accent", cssVar: "--accent", tailwind: "bg-accent" },
  { name: "accent-foreground", cssVar: "--accent-foreground", tailwind: "text-accent-foreground" },
  { name: "destructive", cssVar: "--destructive", tailwind: "bg-destructive", description: "Errors & danger" },
  { name: "border", cssVar: "--border", tailwind: "border-border" },
  { name: "input", cssVar: "--input", tailwind: "border-input" },
  { name: "ring", cssVar: "--ring", tailwind: "ring-ring", description: "Focus rings" },
];

export const CHART_COLOR_TOKENS: ColorToken[] = [
  { name: "chart-1", cssVar: "--chart-1", tailwind: "bg-chart-1" },
  { name: "chart-2", cssVar: "--chart-2", tailwind: "bg-chart-2" },
  { name: "chart-3", cssVar: "--chart-3", tailwind: "bg-chart-3" },
  { name: "chart-4", cssVar: "--chart-4", tailwind: "bg-chart-4" },
  { name: "chart-5", cssVar: "--chart-5", tailwind: "bg-chart-5" },
];

export const SIDEBAR_COLOR_TOKENS: ColorToken[] = [
  { name: "sidebar", cssVar: "--sidebar", tailwind: "bg-sidebar" },
  { name: "sidebar-foreground", cssVar: "--sidebar-foreground", tailwind: "text-sidebar-foreground" },
  { name: "sidebar-primary", cssVar: "--sidebar-primary", tailwind: "bg-sidebar-primary" },
  { name: "sidebar-primary-foreground", cssVar: "--sidebar-primary-foreground", tailwind: "text-sidebar-primary-foreground" },
  { name: "sidebar-accent", cssVar: "--sidebar-accent", tailwind: "bg-sidebar-accent" },
  { name: "sidebar-accent-foreground", cssVar: "--sidebar-accent-foreground", tailwind: "text-sidebar-accent-foreground" },
  { name: "sidebar-border", cssVar: "--sidebar-border", tailwind: "border-sidebar-border" },
  { name: "sidebar-ring", cssVar: "--sidebar-ring", tailwind: "ring-sidebar-ring" },
];

export const RADIUS_TOKENS = [
  { name: "radius (base)", cssVar: "--radius", tailwind: "rounded-lg", value: "0.625rem" },
  { name: "radius-sm", cssVar: "--radius-sm", tailwind: "rounded-sm" },
  { name: "radius-md", cssVar: "--radius-md", tailwind: "rounded-md" },
  { name: "radius-lg", cssVar: "--radius-lg", tailwind: "rounded-lg" },
  { name: "radius-xl", cssVar: "--radius-xl", tailwind: "rounded-xl" },
  { name: "radius-2xl", cssVar: "--radius-2xl", tailwind: "rounded-2xl" },
  { name: "radius-3xl", cssVar: "--radius-3xl", tailwind: "rounded-3xl" },
  { name: "radius-4xl", cssVar: "--radius-4xl", tailwind: "rounded-4xl" },
] as const;

export const TYPOGRAPHY_SCALE = [
  { label: "Display", className: "text-4xl font-semibold tracking-tight", sample: "Colour grading" },
  { label: "Heading 1", className: "text-2xl font-semibold tracking-tight", sample: "Page title" },
  { label: "Heading 2", className: "text-xl font-semibold tracking-tight", sample: "Section title" },
  { label: "Heading 3", className: "text-lg font-medium", sample: "Subsection" },
  { label: "Body", className: "text-sm", sample: "Default body copy for controls and descriptions." },
  { label: "Small / caption", className: "text-xs text-muted-foreground", sample: "Helper text, timestamps, metadata" },
  { label: "Mono", className: "font-mono text-sm", sample: "oklch(0.646 0.222 41.116)" },
] as const;

export const FONT_FAMILIES = [
  { name: "Sans", className: "font-sans", cssVar: "--font-geist-sans", sample: "Geist Sans — UI & headings" },
  { name: "Mono", className: "font-mono", cssVar: "--font-geist-mono", sample: "Geist Mono — code & values" },
] as const;
