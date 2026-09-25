import { landingApiUrl } from "@/lib/config";

/** Readiness: the renderer can reach the API it resolves pages from. */
export const dynamic = "force-dynamic";

export async function GET() {
  let api = false;
  try {
    const res = await fetch(`${landingApiUrl()}/health`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    api = res.ok;
  } catch {
    api = false;
  }
  return Response.json({ ok: api, service: "sites", checks: { api } }, { status: api ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
