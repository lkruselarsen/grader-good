export const DEFAULT_LOADER_UNIT_COLOR = "#ffffff";

const HEX6 = /^#?[0-9a-fA-F]{6}$/;
const HEX3 = /^#?[0-9a-fA-F]{3}$/;

/** Normalize user input to a lowercase #rrggbb string, or null if invalid. */
export function normalizeHexColor(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (HEX6.test(trimmed)) {
    const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    return `#${hex.toLowerCase()}`;
  }

  if (HEX3.test(trimmed)) {
    const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    const expanded = hex
      .split("")
      .map((c) => c + c)
      .join("");
    return `#${expanded.toLowerCase()}`;
  }

  return null;
}

export function resolveUnitColor(color?: string): string {
  return normalizeHexColor(color ?? "") ?? DEFAULT_LOADER_UNIT_COLOR;
}
