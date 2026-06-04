export async function GET(request) {
  return Response.redirect(new URL("/swagger", request.url), 308);
}
