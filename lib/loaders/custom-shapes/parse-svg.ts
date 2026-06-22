import { CUSTOM_SHAPE_LIMITS } from "./types";
import { createCustomShapeId, filenameToShapeName } from "./slug";
import type { CustomGridShapeSvg } from "./types";

const ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "rect",
  "ellipse",
  "line",
  "polyline",
  "polygon",
]);

const BLOCKED_TAGS = new Set(["script", "foreignobject", "iframe", "object", "embed"]);

export type ParseSvgResult =
  | { ok: true; shape: CustomGridShapeSvg; warnings: string[] }
  | { ok: false; error: string };

function stripDangerousAttributes(el: Element) {
  const attrs = Array.from(el.attributes);
  for (const attr of attrs) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === "style" && /url\s*\(/i.test(attr.value)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (
      (name === "href" || name === "xlink:href") &&
      !attr.value.startsWith("#")
    ) {
      el.removeAttribute(attr.name);
    }
  }
}

function sanitizeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (BLOCKED_TAGS.has(tag)) return "";
  if (!ALLOWED_TAGS.has(tag)) return "";

  stripDangerousAttributes(el);

  const inner = Array.from(el.childNodes).map(sanitizeNode).join("");
  const attrs = Array.from(el.attributes)
    .map((a) => `${a.name}="${a.value.replace(/"/g, "&quot;")}"`)
    .join(" ");

  if (tag === "svg") {
    return inner;
  }

  return attrs ? `<${tag} ${attrs}>${inner}</${tag}>` : `<${tag}>${inner}</${tag}>`;
}

function deriveViewBox(svg: SVGSVGElement): string {
  const viewBox = svg.getAttribute("viewBox");
  if (viewBox) return viewBox;

  const w = parseFloat(svg.getAttribute("width") ?? "16");
  const h = parseFloat(svg.getAttribute("height") ?? "16");
  const width = Number.isFinite(w) ? w : 16;
  const height = Number.isFinite(h) ? h : 16;
  return `0 0 ${width} ${height}`;
}

export async function parseSvgFile(file: File): Promise<ParseSvgResult> {
  const warnings: string[] = [];

  if (file.size > CUSTOM_SHAPE_LIMITS.svgMaxBytes) {
    return {
      ok: false,
      error: `SVG must be under ${CUSTOM_SHAPE_LIMITS.svgMaxBytes / 1024} KB`,
    };
  }

  const ext = file.name.toLowerCase();
  if (!ext.endsWith(".svg") && file.type !== "image/svg+xml") {
    return { ok: false, error: "File must be an SVG" };
  }

  const text = (await file.text()).trim();
  if (!text) {
    return { ok: false, error: "SVG file is empty" };
  }

  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    return { ok: false, error: "Invalid SVG markup" };
  }

  const svg = doc.documentElement;
  if (svg.tagName.toLowerCase() !== "svg") {
    return { ok: false, error: "Root element must be <svg>" };
  }

  const viewBox = deriveViewBox(svg as unknown as SVGSVGElement);
  const parts = viewBox.split(/\s+/).map(Number);
  if (parts.length === 4 && (parts[2] !== parts[3])) {
    warnings.push("Non-square viewBox — shape will be scaled to fit");
  }

  const markup = Array.from(svg.childNodes).map(sanitizeNode).join("");
  if (!markup.trim()) {
    return { ok: false, error: "SVG has no drawable content" };
  }

  const name = filenameToShapeName(file.name);
  const shape: CustomGridShapeSvg = {
    id: createCustomShapeId(name, markup),
    name,
    kind: "svg",
    viewBox,
    markup,
    createdAt: Date.now(),
  };

  return { ok: true, shape, warnings };
}
