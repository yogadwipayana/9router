import crypto from "node:crypto";

export const ADMIN_API_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export function adminOptionsResponse() {
  return new Response(null, { status: 204, headers: ADMIN_API_CORS_HEADERS });
}

export function adminJson(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...ADMIN_API_CORS_HEADERS,
      ...(init.headers || {}),
    },
  });
}

export function extractAdminApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim();
  return request.headers.get("x-admin-api-key")?.trim() || "";
}

function getConfiguredAdminApiKey() {
  return process.env.ADMIN_API_KEY?.trim() || "";
}

function constantTimeEqual(a, b) {
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

export async function requireAdminApiKey(request) {
  const configuredKey = getConfiguredAdminApiKey();
  if (!configuredKey) {
    return {
      ok: false,
      response: adminJson(
        { error: "Admin API key is not configured" },
        { status: 503 }
      ),
    };
  }

  const apiKey = extractAdminApiKey(request);
  if (!apiKey) {
    return {
      ok: false,
      response: adminJson({ error: "Missing API key" }, { status: 401 }),
    };
  }

  if (!constantTimeEqual(apiKey, configuredKey)) {
    return {
      ok: false,
      response: adminJson({ error: "Invalid admin API key" }, { status: 401 }),
    };
  }

  return { ok: true };
}

export async function withAdminApiKey(request, handler) {
  const auth = await requireAdminApiKey(request);
  if (!auth.ok) return auth.response;
  return handler(auth);
}
