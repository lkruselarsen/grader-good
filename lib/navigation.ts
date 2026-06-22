import {
  Database,
  FlaskConical,
  FolderOpen,
  GraduationCap,
  LayoutList,
  Microscope,
  Palette,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/lab", label: "Lab 1", icon: FlaskConical },
  { href: "/lab2", label: "Lab 2", icon: Microscope },
  { href: "/trainwithtools", label: "Train With Tools", icon: Wrench },
  { href: "/train", label: "Train", icon: GraduationCap },
  { href: "/dataset", label: "Dataset", icon: Database },
  { href: "/matches", label: "Match list", icon: LayoutList },
  { href: "/bulk-local", label: "Bulk upload", icon: FolderOpen },
  { href: "/loader-lab", label: "Loader lab", icon: Sparkles },
  { href: "/design-system", label: "Design system", icon: Palette },
];

export type BreadcrumbItem = {
  label: string;
  href?: string;
};

export function getNavItemByHref(href: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.href === href);
}

export function buildBreadcrumbs(pathname: string): BreadcrumbItem[] {
  const item = getNavItemByHref(pathname);
  if (!item) {
    return [{ label: "Home", href: "/lab2" }];
  }
  return [{ label: item.label }];
}
