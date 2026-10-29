import type { Metadata } from "next";
import { CloudDownloadPage } from "@/components/cloud/cloud-download-page";

export const metadata: Metadata = {
  title: "Your photos · Grader Good",
};

export default async function CloudBatchPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CloudDownloadPage slug={slug.toLowerCase()} />;
}
