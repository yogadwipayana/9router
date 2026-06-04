import { adminJson, adminOptionsResponse, withAdminApiKey } from "@/lib/adminApiAuth";
import { getChartData, getRecentLogs, getRequestDetails, getUsageStats } from "@/lib/usageDb";
import { getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);
const CHART_PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return adminOptionsResponse();
}

function parseBoundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function buildUsageProviders(details) {
  const providerIds = [...new Set(details.map((row) => row.provider).filter(Boolean))].sort();
  const providerNodes = await getProviderNodes();
  const nodeMap = Object.fromEntries(providerNodes.map((node) => [node.id, node.name]));

  return providerIds.map((providerId) => {
    let name = nodeMap[providerId] || providerId;
    const providerConfig = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
    if (!nodeMap[providerId] && providerConfig?.name) name = providerConfig.name;
    return { id: providerId, name };
  });
}

export async function GET(request) {
  return withAdminApiKey(request, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const period = searchParams.get("period") || "7d";
      if (!VALID_PERIODS.has(period)) {
        return adminJson({ error: "Invalid period" }, { status: 400 });
      }

      const page = parseBoundedInt(searchParams.get("page"), 1, 1, 999999);
      const pageSize = parseBoundedInt(searchParams.get("pageSize"), 20, 1, 100);
      const logsLimit = parseBoundedInt(searchParams.get("logsLimit"), 200, 0, 500);
      const chartPeriod = CHART_PERIODS.has(period) ? period : "60d";
      const detailFilter = { page, pageSize };

      for (const key of ["provider", "model", "connectionId", "status", "startDate", "endDate"]) {
        const value = searchParams.get(key);
        if (value) detailFilter[key] = value;
      }

      const [stats, chart, logs, requestDetails] = await Promise.all([
        getUsageStats(period),
        getChartData(chartPeriod),
        logsLimit > 0 ? getRecentLogs(logsLimit) : [],
        getRequestDetails(detailFilter),
      ]);
      const providers = await buildUsageProviders(requestDetails.details || []);

      return adminJson({
        period,
        chartPeriod,
        stats,
        chart,
        logs,
        requestDetails,
        providers,
      });
    } catch (error) {
      console.error("[Admin API] Failed to fetch usage:", error);
      return adminJson({ error: "Failed to fetch usage" }, { status: 500 });
    }
  });
}
