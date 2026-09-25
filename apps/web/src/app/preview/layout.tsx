import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { ReactNode } from "react";
import { authOptions } from "@/lib/auth";
import { Providers } from "@/app/providers";

/**
 * Full-page draft / template previews. Authenticated only (middleware +
 * this guard), never indexed, and rendered with the same shared renderer
 * as the public site. Data comes from tRPC procedures that re-check
 * ownership (merchant pages) or super_admin scope (templates).
 */
export const metadata = {
  title: "Preview",
  robots: { index: false, follow: false },
};

export default async function PreviewLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login?callbackUrl=/dashboard/landing-pages");
  return <Providers>{children}</Providers>;
}
