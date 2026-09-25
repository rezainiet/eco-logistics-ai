import { DraftPreview } from "@/components/landing/full-preview";

export default function LandingDraftPreviewPage({ params }: { params: { id: string } }) {
  return <DraftPreview pageId={params.id} />;
}
