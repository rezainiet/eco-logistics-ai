import { LandingEditor } from "@/components/landing/landing-editor";

export const metadata = { title: "Edit landing page" };

export default function EditLandingPage({ params }: { params: { id: string } }) {
  return <LandingEditor pageId={params.id} />;
}
