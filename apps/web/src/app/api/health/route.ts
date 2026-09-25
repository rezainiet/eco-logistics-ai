/** Liveness for the reverse proxy / process manager. No auth, no dependencies. */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, service: "web" }, { headers: { "Cache-Control": "no-store" } });
}
