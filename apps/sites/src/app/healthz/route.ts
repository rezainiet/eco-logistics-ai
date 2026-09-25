/** Liveness for the reverse proxy / process manager. No dependencies, any host. */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, service: "sites" }, { headers: { "Cache-Control": "no-store" } });
}
