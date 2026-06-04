import { getOpenApiSpec } from "@/lib/openapi";

const JSON_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

export async function GET() {
  return Response.json(getOpenApiSpec(), { headers: JSON_HEADERS });
}
