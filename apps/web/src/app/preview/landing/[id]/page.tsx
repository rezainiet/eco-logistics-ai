import { DraftPreview } from "@/components/landing/full-preview";

export default function LandingDraftPreviewPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { locale?: string };
}) {
  return <DraftPreview pageId={params.id} initialLocale={searchParams.locale ?? null} />;
}
