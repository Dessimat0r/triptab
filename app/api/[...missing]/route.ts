function missing() {
  return Response.json({ error: "This API endpoint does not exist." }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
export const GET = missing;
export const POST = missing;
export const PUT = missing;
export const PATCH = missing;
export const DELETE = missing;
export const HEAD = missing;
export const OPTIONS = missing;
