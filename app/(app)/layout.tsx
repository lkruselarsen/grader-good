import { AppBreadcrumbs } from "@/components/app/app-breadcrumbs";
import { AppSidebar } from "@/components/app/app-sidebar";
import { FavoritesProvider } from "@/hooks/use-favorites";
import { LoaderLoopsProvider } from "@/hooks/use-loader-loops";
import { SavedLoadersProvider } from "@/hooks/use-saved-loaders";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <FavoritesProvider>
      <SavedLoadersProvider>
        <LoaderLoopsProvider>
          <SidebarProvider defaultOpen>
            <AppSidebar />
            <SidebarInset>
              <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4 md:px-6">
                <SidebarTrigger />
                <AppBreadcrumbs />
              </header>
              <main className="flex-1 p-4 md:p-6">{children}</main>
            </SidebarInset>
          </SidebarProvider>
        </LoaderLoopsProvider>
      </SavedLoadersProvider>
    </FavoritesProvider>
  );
}
