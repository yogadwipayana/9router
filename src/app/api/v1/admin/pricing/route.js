import { adminJson, adminOptionsResponse, withAdminApiKey } from "@/lib/adminApiAuth";
import { getPricing, resetAllPricing, resetPricing, updatePricing } from "@/lib/localDb.js";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return adminOptionsResponse();
}

function validatePricingPayload(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Invalid pricing data format";
  }

  const validFields = ["input", "output", "cached", "reasoning", "cache_creation"];
  for (const [provider, models] of Object.entries(body)) {
    if (typeof models !== "object" || models === null || Array.isArray(models)) {
      return `Invalid pricing for provider: ${provider}`;
    }

    for (const [model, pricing] of Object.entries(models)) {
      if (typeof pricing !== "object" || pricing === null || Array.isArray(pricing)) {
        return `Invalid pricing for model: ${provider}/${model}`;
      }

      for (const [key, value] of Object.entries(pricing)) {
        if (!validFields.includes(key)) {
          return `Invalid pricing field: ${key} for ${provider}/${model}`;
        }
        if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
          return `Invalid pricing value for ${key} in ${provider}/${model}: must be non-negative number`;
        }
      }
    }
  }

  return null;
}

export async function GET(request) {
  return withAdminApiKey(request, async () => {
    try {
      const pricing = await getPricing();
      return adminJson(pricing);
    } catch (error) {
      console.error("[Admin API] Failed to fetch pricing:", error);
      return adminJson({ error: "Failed to fetch pricing" }, { status: 500 });
    }
  });
}

export async function PATCH(request) {
  return withAdminApiKey(request, async () => {
    try {
      const body = await request.json();
      const validationError = validatePricingPayload(body);
      if (validationError) return adminJson({ error: validationError }, { status: 400 });

      const pricing = await updatePricing(body);
      return adminJson(pricing);
    } catch (error) {
      console.error("[Admin API] Failed to update pricing:", error);
      return adminJson({ error: "Failed to update pricing" }, { status: 500 });
    }
  });
}

export async function DELETE(request) {
  return withAdminApiKey(request, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const provider = searchParams.get("provider");
      const model = searchParams.get("model");

      if (provider && model) {
        await resetPricing(provider, model);
      } else if (provider) {
        await resetPricing(provider);
      } else {
        await resetAllPricing();
      }

      const pricing = await getPricing();
      return adminJson(pricing);
    } catch (error) {
      console.error("[Admin API] Failed to reset pricing:", error);
      return adminJson({ error: "Failed to reset pricing" }, { status: 500 });
    }
  });
}
