import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle>Ecommerce Logistics</CardTitle>
          <CardDescription>Unified logistics management platform.</CardDescription>
        </CardHeader>
      </Card>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/login">Sign in</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/signup">Create account</Link>
        </Button>
      </div>
    </main>
  );
}
