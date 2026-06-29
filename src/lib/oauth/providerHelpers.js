const BASE64_BLOCK_SIZE = 4;

function validateXaiOAuthEndpoint(rawUrl, field) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error(`xai discovery ${field} is empty`);
  let parsed;
  try { parsed = new URL(value); } catch (err) {
    throw new Error(`xai discovery ${field} is invalid: ${err.message}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`xai discovery ${field} must use https: ${value}`);
  const host = parsed.hostname.toLowerCase().trim();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`xai discovery ${field} host ${host} is not on x.ai`);
  }
  return value;
}

function decodeXaiIdTokenEmail(idToken) {
  if (!idToken || typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const json = Buffer.from(base64 + "=".repeat(padding), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload.email || payload.preferred_username || payload.sub || undefined;
  } catch {
    return undefined;
  }
}

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractEmailFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  return payload.email || payload.preferred_username || payload.sub || undefined;
}

// AWS regions where Amazon Q Developer (formerly CodeWhisperer) Pro profiles
// can be created. Per AWS, profiles exist only in us-east-1 (N. Virginia) and
// eu-central-1 (Frankfurt). ListAvailableProfiles is per-region, so an account
// whose profile is in Frankfurt returns nothing when queried in us-east-1.
const KIRO_PROFILE_REGIONS = ["us-east-1", "eu-central-1"];

async function listKiroProfileArnInRegion(accessToken, region) {
  const arnOf = (p) => p?.arn?.trim?.() || p?.profileArn?.trim?.() || null;
  // CodeWhisperer merged into Amazon Q Developer. The legacy
  // `codewhisperer.{region}` host only resolves in us-east-1; the regional
  // service (e.g. an eu-central-1 profile) lives at `q.{region}.amazonaws.com`.
  // We don't know each host's exact protocol for certain, so try the known
  // variants and log which one works.
  const rpcHeaders = {
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const restHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const attempts = [
    { label: "q-rpc", url: `https://q.${region}.amazonaws.com`, headers: rpcHeaders },
    { label: "cw-rpc", url: `https://codewhisperer.${region}.amazonaws.com`, headers: rpcHeaders },
    { label: "q-rest", url: `https://q.${region}.amazonaws.com/ListAvailableProfiles`, headers: restHeaders },
  ];

  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, {
        method: "POST",
        headers: attempt.headers,
        body: JSON.stringify({ maxResults: 10 }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.log(`[KIRO_PROFILE] ${region} ${attempt.label}: HTTP ${response.status} :: ${body.slice(0, 200)}`);
        continue;
      }
      const data = await response.json();
      const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
      console.log(
        `[KIRO_PROFILE] ${region} ${attempt.label}: ${profiles.length} profile(s): ${profiles.map(arnOf).filter(Boolean).join(", ") || "(none)"}`,
      );
      const match = profiles.find((p) => arnOf(p)?.split(":")[3] === region) || profiles[0];
      const arn = arnOf(match);
      if (arn) return arn;
    } catch (e) {
      console.log(`[KIRO_PROFILE] ${region} ${attempt.label}: error ${e?.message || e}`);
    }
  }
  return null;
}

export async function fetchKiroProfileArn(accessToken, region) {
  if (!accessToken) return null;
  // Try the caller-provided region first (validated to avoid SSRF), then the
  // remaining known Kiro/Q regions. Return the first profile ARN found — its
  // region (embedded in the ARN) becomes the source of truth for inference and
  // quota calls downstream.
  const REGION_RE = /^[a-z]{2}-[a-z]+-\d{1,2}$/;
  const preferred = REGION_RE.test(region || "") ? [region] : [];
  const candidates = [...new Set([...preferred, ...KIRO_PROFILE_REGIONS])];
  for (const r of candidates) {
    const arn = await listKiroProfileArnInRegion(accessToken, r);
    if (arn) return arn;
  }
  return null;
}

export function extractCodexAccountInfo(idToken) {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return {};
  const chatgpt = payload["https://api.openai.com/auth"] || {};
  return {
    email: payload.email,
    chatgptAccountId: chatgpt.chatgpt_account_id || payload.account_id,
    chatgptPlanType: chatgpt.chatgpt_plan_type || payload.plan_type,
  };
}

export {
  BASE64_BLOCK_SIZE,
  validateXaiOAuthEndpoint,
  decodeXaiIdTokenEmail,
  decodeJwtPayload,
  extractEmailFromAccessToken,
};
