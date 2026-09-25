import { TemplateVersionPreview } from "@/components/landing/full-preview";

export default function TemplatePreviewPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { version?: string };
}) {
  const version = Number(searchParams.version);
  return <TemplateVersionPreview templateId={params.id} version={Number.isInteger(version) && version > 0 ? version : null} />;
}
