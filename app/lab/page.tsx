"use client";

import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ImgFile = { id: string; file: File; url: string };

function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

async function drawToCanvas(canvas: HTMLCanvasElement, srcUrl: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = srcUrl;
  });

  // Fit into a reasonable preview size
  const maxEdge = 1600;
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
}

function applyBasicLook(canvas: HTMLCanvasElement, strength: number) {
  // Placeholder: tiny contrast/sat-ish effect just to prove the pipeline + sliders.
  // We'll replace this with OKLab model + reference fitting.
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;

  const s = strength; // 0..1
  // Basic curve: lift shadows a bit + compress highlights a bit (cheap "filmic-ish")
  const lift = 12 * s;
  const comp = 18 * s;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i],
      g = d[i + 1],
      b = d[i + 2];

    // luma
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // lift shadows
    const shadow = (1 - y / 255) * lift;
    r = Math.min(255, r + shadow);
    g = Math.min(255, g + shadow);
    b = Math.min(255, b + shadow);

    // compress highlights
    const hi = Math.max(0, (y - 220) / 35);
    const hcomp = hi * comp;
    r = Math.max(0, r - hcomp);
    g = Math.max(0, g - hcomp);
    b = Math.max(0, b - hcomp);

    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    // alpha unchanged
  }

  ctx.putImageData(img, 0, 0);
}

export default function LabPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [source, setSource] = useState<ImgFile | null>(null);
  const [refs, setRefs] = useState<ImgFile[]>([]);
  const [activeRefId, setActiveRefId] = useState<string | null>(null);

  const [strength, setStrength] = useState<number>(0.35);
  const activeRef = useMemo(
    () => refs.find((r) => r.id === activeRefId) ?? null,
    [refs, activeRefId]
  );

  async function onPickSource(file: File | null) {
    if (!file) return;
    const url = await fileToDataUrl(file);
    const item = { id: uuid(), file, url };
    setSource(item);
    // render immediately
    if (canvasRef.current) await drawToCanvas(canvasRef.current, url);
  }

  async function onPickRefs(files: FileList | null) {
    if (!files || files.length === 0) return;
    const items: ImgFile[] = [];
    for (const f of Array.from(files)) {
      const url = await fileToDataUrl(f);
      items.push({ id: uuid(), file: f, url });
    }
    setRefs((prev) => [...prev, ...items]);
    if (!activeRefId && items[0]) setActiveRefId(items[0].id);
  }

  async function onRunMatch() {
    if (!source?.url || !canvasRef.current) return;
    await drawToCanvas(canvasRef.current, source.url);
    applyBasicLook(canvasRef.current, strength);
  }

  async function onExport() {
    const c = canvasRef.current;
    if (!c) return;
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `graded_${source?.file.name ?? "image"}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Lab</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-4">
          <div className="space-y-2">
            <Label>Source (JPG/PNG for now)</Label>
            <Input
              type="file"
              accept="image/png,image/jpeg"
              onChange={(e) => onPickSource(e.target.files?.[0] ?? null)}
            />
          </div>

          <div className="space-y-2">
            <Label>Reference photos (3–4)</Label>
            <Input
              type="file"
              multiple
              accept="image/png,image/jpeg"
              onChange={(e) => onPickRefs(e.target.files)}
            />
          </div>

          <Tabs
            value={activeRefId ?? ""}
            onValueChange={(v) => setActiveRefId(v)}
          >
            <TabsList className="flex flex-wrap">
              {refs.map((r, idx) => (
                <TabsTrigger key={r.id} value={r.id}>
                  Ref {idx + 1}
                </TabsTrigger>
              ))}
            </TabsList>
            {refs.map((r) => (
              <TabsContent key={r.id} value={r.id} className="pt-3">
                <div className="flex gap-3 items-start">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={r.url}
                    alt="reference"
                    className="w-40 h-40 object-cover rounded-md border"
                  />
                  <div className="text-sm text-muted-foreground">
                    {r.file.name}
                  </div>
                </div>
              </TabsContent>
            ))}
          </Tabs>

          <div className="space-y-2">
            <Label>Match strength</Label>
            <Slider
              value={[strength]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) => setStrength(v[0] ?? 0)}
            />
          </div>

          <div className="flex gap-2">
            <Button onClick={onRunMatch} disabled={!source}>
              Run match (stub)
            </Button>
            <Button variant="secondary" onClick={onExport} disabled={!source}>
              Export PNG
            </Button>
          </div>

          <div className="text-xs text-muted-foreground">
            Active ref: {activeRef ? activeRef.file.name : "none"}
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-sm text-muted-foreground mb-2">Preview</div>
          <canvas ref={canvasRef} className="w-full rounded-md border" />
        </Card>
      </div>
    </div>
  );
}
