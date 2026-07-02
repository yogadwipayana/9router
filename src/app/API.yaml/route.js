import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

// docs/API.yaml is the single source of truth for the OpenAPI spec.
// Candidates cover both standalone tracing-root modes (projectRoot vs workspace).
const CANDIDATES = [
  path.join(process.cwd(), "docs", "API.yaml"),
  path.join(process.cwd(), "..", "docs", "API.yaml"),
];

export async function GET() {
  for (const candidate of CANDIDATES) {
    try {
      const yaml = await readFile(candidate, "utf8");
      return new Response(yaml, {
        headers: {
          "Content-Type": "application/yaml; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      // try next candidate
    }
  }
  return new Response("API.yaml not found", { status: 404 });
}
