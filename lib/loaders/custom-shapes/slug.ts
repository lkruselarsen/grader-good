export function filenameToShapeName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  return base || "custom-shape";
}

export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "shape";
}

export function shortHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).slice(0, 6).padStart(6, "0");
}

export function createCustomShapeId(name: string, content: string): string {
  return `custom-${slugifyName(name)}-${shortHash(content + name + Date.now())}`;
}
