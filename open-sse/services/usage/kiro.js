/**
 * Kiro (AWS CodeWhisperer) usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { resolveDefaultProfileArn } from "../../config/kiroConstants.js";
import { U, parseResetTime } from "./shared.js";

/**
 * Kiro (AWS CodeWhisperer) Usage
 */
function parseKiroQuotaData(data) {
  const usageList = data.usageBreakdownList || [];
  const quotaInfo = {};
  const resetAt = parseResetTime(data.nextDateReset || data.resetDate);

  usageList.forEach((breakdown) => {
    const resourceType = breakdown.resourceType?.toLowerCase() || "unknown";
    const used = breakdown.currentUsageWithPrecision || 0;
    const total = breakdown.usageLimitWithPrecision || 0;

    quotaInfo[resourceType] = {
      used,
      total,
      remaining: total - used,
      resetAt,
      unlimited: false,
    };

    // Add free trial if available
    if (breakdown.freeTrialInfo) {
      const freeUsed = breakdown.freeTrialInfo.currentUsageWithPrecision || 0;
      const freeTotal = breakdown.freeTrialInfo.usageLimitWithPrecision || 0;

      quotaInfo[`${resourceType}_freetrial`] = {
        used: freeUsed,
        total: freeTotal,
        remaining: freeTotal - freeUsed,
        resetAt: parseResetTime(breakdown.freeTrialInfo.freeTrialExpiry || resetAt),
        unlimited: false,
      };
    }
  });

  return {
    plan: data.subscriptionInfo?.subscriptionTitle || "Kiro",
    quotas: quotaInfo,
  };
}

export async function getKiroUsage(accessToken, providerSpecificData, proxyOptions = null) {
  const authMethod = providerSpecificData?.authMethod || "builder-id";
  const isApiKey = authMethod === "api_key";
  const isExternalIdp = authMethod === "external_idp";
  const externalIdpHeaders = isExternalIdp ? { TokenType: "EXTERNAL_IDP" } : {};

  // For api-key auth, never inject the shared default placeholder profileArn —
  // CodeWhisperer 403s a request whose profileArn isn't owned by the key's
  // account. The same is true for IDC: the shared Builder ID default ARN is
  // not owned by the org's IDC account, so sending it guarantees a 403 on
  // GetUsageLimits. In both cases only send a profileArn actually resolved for
  // this connection (omitting it otherwise).
  const noDefaultArn = isApiKey || authMethod === "idc";
  const profileArn = noDefaultArn
    ? (providerSpecificData?.profileArn || "")
    : (providerSpecificData?.profileArn || resolveDefaultProfileArn(authMethod));

  // Region-aware quota hosts. The registry usage hosts are pinned to us-east-1,
  // but a connection's resources may live elsewhere (e.g. an IDC profile in
  // eu-central-1). Prefer the region embedded in the profileArn, then the
  // region stored at login, then us-east-1.
  const REGION_RE = /^[a-z]{2}-[a-z]+-\d{1,2}$/;
  const arnRegion = typeof profileArn === "string" ? (profileArn.split(":")[3] || "") : "";
  const psdRegion = typeof providerSpecificData?.region === "string" ? providerSpecificData.region.trim() : "";
  const region = REGION_RE.test(arnRegion) ? arnRegion : (REGION_RE.test(psdRegion) ? psdRegion : "us-east-1");
  const usage = U("kiro");
  const cwHost = (usage.cwHost || "").replace("us-east-1", region);
  const qHost = (usage.qHost || "").replace("us-east-1", region);
  const limitsPath = usage.limitsPath || "";

  const getUsageParams = new URLSearchParams({
    isEmailRequired: "true",
    origin: "AI_EDITOR",
    resourceType: "AGENTIC_REQUEST",
  });

  // API-key auth uses Kiro's own management gateway, which accepts a raw
  // long-lived API key as a bearer token. The AWS CodeWhisperer/Q hosts reject
  // that same key with 401/403, so they're only used for OAuth-derived tokens.
  const attempts = isApiKey
    ? [
        {
          name: "management-get",
          run: async () => proxyAwareFetch(
            `https://management.${region}.kiro.dev${limitsPath}?${getUsageParams.toString()}`,
            {
              method: "GET",
              headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Accept": "application/json",
                "TokenType": "API_KEY",
              },
            },
            proxyOptions
          ),
        },
      ]
    : [
        {
          name: "codewhisperer-get",
          run: async () => proxyAwareFetch(
            `${cwHost}${limitsPath}?${getUsageParams.toString()}`,
            {
              method: "GET",
              headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Accept": "application/json",
                "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroIDE",
                "user-agent": "aws-sdk-js/1.0.0 KiroIDE",
                ...externalIdpHeaders,
              },
            },
            proxyOptions
          ),
        },
        {
          name: "codewhisperer-post",
          run: async () => proxyAwareFetch(cwHost, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/x-amz-json-1.0",
              "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
              "Accept": "application/json",
              ...externalIdpHeaders,
            },
            body: JSON.stringify({
              origin: "AI_EDITOR",
              ...(profileArn ? { profileArn } : {}),
              resourceType: "AGENTIC_REQUEST",
            }),
          }, proxyOptions),
        },
        {
          name: "q-get",
          run: async () => {
            const params = new URLSearchParams({
              origin: "AI_EDITOR",
              ...(profileArn ? { profileArn } : {}),
              resourceType: "AGENTIC_REQUEST",
            });
            return proxyAwareFetch(`${qHost}${limitsPath}?${params}`, {
              method: "GET",
              headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Accept": "application/json",
                ...externalIdpHeaders,
              },
            }, proxyOptions);
          },
        },
      ];

  let sawAuthError = false;
  const errors = [];

  for (const attempt of attempts) {
    try {
      const response = await attempt.run();
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (response.status === 401 || response.status === 403) {
          sawAuthError = true;
        }
        errors.push(`${attempt.name}:${response.status}${errorText ? `:${errorText}` : ""}`);
        continue;
      }

      const data = await response.json();
      return parseKiroQuotaData(data);
    } catch (error) {
      errors.push(`${attempt.name}:${error.message}`);
    }
  }

  if (sawAuthError && authMethod === "idc") {
    const detail = errors.length ? ` [${errors.join(" | ")}]` : "";
    console.log(`[KIRO_USAGE] idc region=${region} profileArn=${profileArn || "(none)"} ::${detail}`);
    return {
      message:
        "Kiro quota API is unavailable for the current AWS IAM Identity Center session. Chat may still work. If this persists after renewing your session, reconnect Kiro." +
        detail,
      quotas: {},
    };
  }

  // Social auth (Google/GitHub) - these use a different token format that may not work with AWS CodeWhisperer quota APIs
  if (sawAuthError && (authMethod === "google" || authMethod === "github")) {
    return {
      message: "Kiro quota API authentication expired. Chat may still work.",
      quotas: {},
    };
  }

  if (sawAuthError) {
    return {
      message: "Kiro quota API rejected the current token. Chat may still work.",
      quotas: {},
    };
  }

  const fallbackMessage =
    errors.length > 0
      ? `Unable to fetch Kiro usage right now. (${errors[errors.length - 1]})`
      : "Unable to fetch Kiro usage right now.";

  return {
    message: fallbackMessage,
    quotas: {},
  };
}
