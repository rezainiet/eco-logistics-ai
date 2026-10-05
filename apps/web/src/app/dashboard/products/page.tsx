import { Suspense } from "react";
import { ProductsList } from "@/components/commerce/products-list";

export const metadata = { title: "Products" };

export default function ProductsPage() {
  // ProductsList reads ?stock=<id> (stock notification deep link).
  return (
    <Suspense>
      <ProductsList />
    </Suspense>
  );
}
