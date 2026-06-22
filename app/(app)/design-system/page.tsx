"use client";

import { useState } from "react";
import {
  ChevronDown,
  MoreHorizontal,
  Plus,
  Search,
  Star,
} from "lucide-react";
import { AsyncState } from "@/components/app/async-state";
import { EmptyState } from "@/components/app/empty-state";
import { GridLoader } from "@/components/app/grid-loader";
import { ConfigurableLoader } from "@/components/loaders/configurable-loader";
import { LoadingButton } from "@/components/app/loading-button";
import { PageHeader } from "@/components/app/page-header";
import { ProgressWithLabel } from "@/components/app/progress-with-label";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { ColorSwatchGrid } from "@/components/design-system/color-swatch";
import { SavedLoadersShowcase } from "@/components/design-system/saved-loaders-showcase";
import {
  DesignSystemSection,
  ShowcasePanel,
} from "@/components/design-system/section";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CHART_COLOR_TOKENS,
  FONT_FAMILIES,
  RADIUS_TOKENS,
  SEMANTIC_COLOR_TOKENS,
  SIDEBAR_COLOR_TOKENS,
  TYPOGRAPHY_SCALE,
} from "@/lib/design-system/tokens";
import { DEFAULT_GRID_PRESET, GRID_PRESETS } from "@/lib/loaders/presets";
import { cn } from "@/lib/utils";

const SECTION_LINKS = [
  { id: "typography", label: "Typography" },
  { id: "colors", label: "Colors" },
  { id: "tokens", label: "Tokens" },
  { id: "primitives", label: "UI primitives" },
  { id: "composites", label: "App composites" },
  { id: "loaders", label: "Saved loaders" },
] as const;

const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
] as const;

const BUTTON_SIZES = ["xs", "sm", "default", "lg"] as const;

const BADGE_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "destructive",
  "ghost",
] as const;

export default function DesignSystemPage() {
  const [sliderValue, setSliderValue] = useState([42]);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [asyncStatus, setAsyncStatus] = useState<
    "idle" | "loading" | "empty" | "error" | "success"
  >("success");

  return (
    <div className="mx-auto max-w-6xl space-y-10 pb-16">
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Design system"
          description="Typography, tokens, shadcn/ui primitives, and app-level composites used across Grader Good."
          href="/design-system"
          className="mb-0 flex-1"
        />
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Preview in
          </span>
          <ThemeToggle />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Stack</CardTitle>
          <CardDescription>
            Tailwind CSS v4 · shadcn/ui · Radix primitives · Geist fonts ·
            next-themes (light / dark)
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Tokens live in{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            app/globals.css
          </code>
          . Primitives are in{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            components/ui/
          </code>
          . Reusable app patterns are in{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            components/app/
          </code>
          .
        </CardContent>
      </Card>

      <nav className="sticky top-0 z-10 -mx-1 overflow-x-auto border-b bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex gap-1">
          {SECTION_LINKS.map((link) => (
            <a
              key={link.id}
              href={`#${link.id}`}
              className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {link.label}
            </a>
          ))}
        </div>
      </nav>

      <DesignSystemSection
        id="typography"
        title="Typography"
        description="Geist Sans for UI; Geist Mono for code and technical values."
      >
        <ShowcasePanel title="Font families">
          <div className="space-y-4">
            {FONT_FAMILIES.map((font) => (
              <div key={font.name} className="space-y-1">
                <p className={cn("text-lg", font.className)}>{font.sample}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {font.className} · {font.cssVar}
                </p>
              </div>
            ))}
          </div>
        </ShowcasePanel>

        <ShowcasePanel title="Type scale">
          <div className="space-y-6">
            {TYPOGRAPHY_SCALE.map((row) => (
              <div key={row.label} className="space-y-1 border-b pb-4 last:border-0 last:pb-0">
                <p className="text-xs font-medium text-muted-foreground">
                  {row.label}
                </p>
                <p className={row.className}>{row.sample}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {row.className}
                </p>
              </div>
            ))}
          </div>
        </ShowcasePanel>
      </DesignSystemSection>

      <Separator />

      <DesignSystemSection
        id="colors"
        title="Colors"
        description="Semantic OKLCH tokens — values switch automatically between light and dark themes."
      >
        <ShowcasePanel title="Semantic">
          <ColorSwatchGrid tokens={SEMANTIC_COLOR_TOKENS} />
        </ShowcasePanel>

        <ShowcasePanel title="Charts">
          <ColorSwatchGrid tokens={CHART_COLOR_TOKENS} />
        </ShowcasePanel>

        <ShowcasePanel title="Sidebar">
          <ColorSwatchGrid tokens={SIDEBAR_COLOR_TOKENS} />
        </ShowcasePanel>
      </DesignSystemSection>

      <Separator />

      <DesignSystemSection
        id="tokens"
        title="Tokens"
        description="Radius and spacing primitives mapped through CSS custom properties."
      >
        <ShowcasePanel title="Border radius">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {RADIUS_TOKENS.map((token) => (
              <div key={token.name} className="space-y-2">
                <div
                  className={cn(
                    "h-16 w-full border-2 border-primary bg-muted",
                    token.tailwind
                  )}
                />
                <div>
                  <p className="text-sm font-medium">{token.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {token.cssVar}
                    {"value" in token ? ` · ${token.value}` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </ShowcasePanel>

        <ShowcasePanel title="Common spacing patterns">
          <div className="space-y-3 font-mono text-xs text-muted-foreground">
            <p>
              <span className="text-foreground">Page padding</span> — p-4 md:p-6
              (main content area)
            </p>
            <p>
              <span className="text-foreground">Section gap</span> — space-y-6 /
              space-y-10 between major blocks
            </p>
            <p>
              <span className="text-foreground">Card padding</span> — px-6 py-6
              (Card component)
            </p>
            <p>
              <span className="text-foreground">Control gap</span> — gap-2 /
              gap-4 in flex layouts
            </p>
          </div>
        </ShowcasePanel>
      </DesignSystemSection>

      <Separator />

      <DesignSystemSection
        id="primitives"
        title="UI primitives"
        description="shadcn/ui components in components/ui/."
      >
        <ShowcasePanel title="Button">
          <div className="space-y-6">
            <div className="flex flex-wrap gap-2">
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant}>
                  {variant}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {BUTTON_SIZES.map((size) => (
                <Button key={size} size={size}>
                  {size}
                </Button>
              ))}
              <Button size="icon" aria-label="Add">
                <Plus />
              </Button>
            </div>
          </div>
        </ShowcasePanel>

        <ShowcasePanel title="Badge">
          <div className="flex flex-wrap gap-2">
            {BADGE_VARIANTS.map((variant) => (
              <Badge key={variant} variant={variant}>
                {variant}
              </Badge>
            ))}
          </div>
        </ShowcasePanel>

        <ShowcasePanel title="Form controls">
          <div className="grid max-w-md gap-6">
            <div className="space-y-2">
              <Label htmlFor="ds-input">Input</Label>
              <div className="relative">
                <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="ds-input"
                  className="pl-8"
                  placeholder="Search samples…"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox id="ds-checkbox" defaultChecked />
              <Label htmlFor="ds-checkbox">Checkbox</Label>
            </div>

            <RadioGroup defaultValue="standard" className="space-y-2">
              <div className="flex items-center gap-2">
                <RadioGroupItem value="standard" id="ds-radio-1" />
                <Label htmlFor="ds-radio-1">Standard match</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="hybrid" id="ds-radio-2" />
                <Label htmlFor="ds-radio-2">Hybrid match</Label>
              </div>
            </RadioGroup>

            <div className="space-y-2">
              <Label>Select</Label>
              <Select defaultValue="lab2">
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick a page" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lab2">Lab 2</SelectItem>
                  <SelectItem value="bulk">Bulk upload</SelectItem>
                  <SelectItem value="dataset">Dataset</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Slider</Label>
                <span className="font-mono text-xs text-muted-foreground">
                  {sliderValue[0]}
                </span>
              </div>
              <Slider
                value={sliderValue}
                onValueChange={setSliderValue}
                max={100}
                step={1}
              />
            </div>
          </div>
        </ShowcasePanel>

        <ShowcasePanel title="Card">
          <Card className="max-w-sm">
            <CardHeader>
              <CardTitle>Reference match</CardTitle>
              <CardDescription>
                Top-ranked grading sample applied to source.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Cards group related content with consistent padding and elevation.
            </CardContent>
            <CardFooter>
              <Button size="sm">Apply</Button>
            </CardFooter>
          </Card>
        </ShowcasePanel>

        <ShowcasePanel title="Tabs">
          <Tabs defaultValue="standard" className="max-w-md">
            <TabsList>
              <TabsTrigger value="standard">Standard</TabsTrigger>
              <TabsTrigger value="1090">10/90</TabsTrigger>
              <TabsTrigger value="5050">50/50</TabsTrigger>
            </TabsList>
            <TabsContent value="standard" className="text-sm text-muted-foreground">
              Semantic tile match — default algorithm.
            </TabsContent>
            <TabsContent value="1090" className="text-sm text-muted-foreground">
              Tonal-heavy hybrid weighting.
            </TabsContent>
            <TabsContent value="5050" className="text-sm text-muted-foreground">
              Balanced tonal + chroma hybrid.
            </TabsContent>
          </Tabs>
        </ShowcasePanel>

        <ShowcasePanel title="Accordion">
          <Accordion type="single" collapsible defaultValue="source" className="max-w-md">
            <AccordionItem value="source">
              <AccordionTrigger>Source &amp; match</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Collapsible sections keep dense controls scannable.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="grading">
              <AccordionTrigger>Grading</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Exposure, contrast, colour wheels, and more.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </ShowcasePanel>

        <ShowcasePanel title="Dropdown menu">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                Export
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Export options</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>PNG preview</DropdownMenuItem>
              <DropdownMenuItem>TIFF 16-bit</DropdownMenuItem>
              <DropdownMenuItem>DNG with edits</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ShowcasePanel>

        <ShowcasePanel title="Tooltip">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Favourite">
                <Star className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Add to favourites</TooltipContent>
          </Tooltip>
        </ShowcasePanel>

        <ShowcasePanel title="Feedback">
          <div className="space-y-6">
            <ProgressWithLabel value={65} label="Processing image 3 of 12" />
            <div className="flex gap-4">
              <Skeleton className="h-12 w-12 rounded" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </div>
          </div>
        </ShowcasePanel>

        <ShowcasePanel title="Scroll area">
          <ScrollArea className="h-24 w-full rounded-md border p-3">
            <p className="text-sm text-muted-foreground">
              Scroll areas contain overflowing content — useful for thumbnail
              rows, log output, or long option lists without breaking layout.
            </p>
            <p className="mt-4 text-sm text-muted-foreground">
              Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do
              eiusmod tempor incididunt ut labore et dolore magna aliqua.
            </p>
          </ScrollArea>
        </ShowcasePanel>

        <ShowcasePanel title="More menu icon">
          <Button variant="ghost" size="icon" aria-label="More options">
            <MoreHorizontal />
          </Button>
        </ShowcasePanel>
      </DesignSystemSection>

      <Separator />

      <DesignSystemSection
        id="composites"
        title="App composites"
        description="Higher-level patterns built from primitives — used across Lab 2, bulk upload, and data pages."
      >
        <ShowcasePanel title="LoadingButton">
          <LoadingButton
            loading={loadingDemo}
            loadingText="Exporting…"
            onClick={() => {
              setLoadingDemo(true);
              window.setTimeout(() => setLoadingDemo(false), 2000);
            }}
          >
            Export graded TIFF
          </LoadingButton>
        </ShowcasePanel>

        <ShowcasePanel title="EmptyState">
          <div className="grid gap-4 md:grid-cols-2">
            <EmptyState
              title="Uploads will appear here"
              description="Drop source images in the sidebar to start bulk processing."
            />
            <EmptyState
              variant="error"
              title="Failed to load samples"
              description="Check your connection and try again."
              action={
                <Button size="sm" variant="outline">
                  Retry
                </Button>
              }
            />
          </div>
        </ShowcasePanel>

        <ShowcasePanel title="GridLoader">
          <GridLoader label="Decoding source…" />
        </ShowcasePanel>

        <ShowcasePanel title="ConfigurableLoader">
          <div className="flex flex-wrap gap-8">
            <ConfigurableLoader
              definition={DEFAULT_GRID_PRESET}
              label="Default 3×3 cumulative fill"
            />
            <ConfigurableLoader
              definition={GRID_PRESETS[1]}
              label="Sin wave"
            />
            <ConfigurableLoader
              definition={GRID_PRESETS[3]}
              label="BFS traversal"
            />
          </div>
        </ShowcasePanel>

        <ShowcasePanel title="AsyncState">
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {(["loading", "empty", "error", "success"] as const).map(
                (status) => (
                  <Button
                    key={status}
                    size="sm"
                    variant={asyncStatus === status ? "default" : "outline"}
                    onClick={() => setAsyncStatus(status)}
                  >
                    {status}
                  </Button>
                )
              )}
            </div>
            <div className="rounded-lg border p-4">
              <AsyncState
                status={asyncStatus}
                loading={<GridLoader label="Loading data…" />}
                empty={
                  <EmptyState
                    title="No results"
                    description="Try adjusting your filters."
                  />
                }
                error={
                  <EmptyState
                    variant="error"
                    title="Something went wrong"
                    description="The request could not be completed."
                  />
                }
              >
                <p className="text-sm text-muted-foreground">
                  Content loaded successfully.
                </p>
              </AsyncState>
            </div>
          </div>
        </ShowcasePanel>

        <ShowcasePanel title="Other composites">
          <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
            <li>
              <code className="font-mono text-xs">PageHeader</code> — page title
              with favourite star (shown at top of this page)
            </li>
            <li>
              <code className="font-mono text-xs">DataTable</code> — TanStack
              table wrapper with sorting and pagination
            </li>
            <li>
              <code className="font-mono text-xs">FileDropzone</code> — drag &
              drop upload areas for RAW/DNG sources
            </li>
            <li>
              <code className="font-mono text-xs">BulkProgressStatus</code> —
              GridLoader + phase + image count + ETA
            </li>
            <li>
              <code className="font-mono text-xs">PanelSidebar</code> — resizable
              right-hand controls panel (Lab 2 &amp; bulk upload)
            </li>
            <li>
              <code className="font-mono text-xs">ThemeToggle</code> — light /
              dark mode switch (header of this page)
            </li>
          </ul>
        </ShowcasePanel>
      </DesignSystemSection>

      <Separator />

      <DesignSystemSection
        id="loaders"
        title="Saved loaders"
        description="Loading animations saved from Loader Lab — review, reopen, or copy JSON for use in the app."
      >
        <ShowcasePanel>
          <SavedLoadersShowcase />
        </ShowcasePanel>
      </DesignSystemSection>
    </div>
  );
}
