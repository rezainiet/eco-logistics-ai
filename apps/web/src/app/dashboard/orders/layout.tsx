import type { ReactNode } from "react";

// The orders page is a client component and can't export metadata itself;
// this segment layout gives the tab a real title ("Orders · ConfirmX").
export const metadata = { title: "Orders" };

export default function OrdersLayout({ children }: { children: ReactNode }) {
  return children;
}
