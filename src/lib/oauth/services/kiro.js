import { KIRO_CONFIG, assertValidAwsRegion } from "../constants/oauth.js";

/**
 * Kiro OAuth Service
 * Supports multiple authentication methods:
 * 1. AWS Builder ID (Device Code Flow)
 * 2. AWS IAM Identity Center/IDC (Device Code Flow)
 * 3. Google/GitHub Social Login (Authorization Code Flow + Manual Callback)
 * 4. Import Token (Manual refresh token paste)
 */

const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";

export class KiroService {
  /**
   * Register OIDC client with AWS SSO
   * Returns clientId and clientSecret for device code flow
   */
  async registerClient(region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://oidc.${region}.amazonaws.com/client/register`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientName: KIRO_CONFIG.clientName,
        clientType: KIRO_CONFIG.clientType,
        scopes: KIRO_CONFIG.scopes,
        grantTypes: KIRO_CONFIG.grantTypes,
        issuerUrl: KIRO_CONFIG.issuerUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to register client: ${error}`);
    }

    const data = await response.json();
    return {
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      clientSecretExpiresAt: data.clientSecretExpiresAt,
    };
  }

  /**
   * Start device authorization for AWS Builder ID or IDC
   */
  async startDeviceAuthorization(clientId, clientSecret, startUrl, region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://oidc.${region}.amazonaws.com/device_authorization`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to start device authorization: ${error}`);
    }

    const data = await response.json();
    return {
      deviceCode: data.deviceCode,
      userCode: data.userCode,
      verificationUri: data.verificationUri,
      verificationUriComplete: data.verificationUriComplete,
      expiresIn: data.expiresIn,
      interval: data.interval || 5,
    };
  }

  /**
   * Poll for token using device code (AWS Builder ID/IDC)
   */
  async pollDeviceToken(clientId, clientSecret, deviceCode, region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://oidc.${region}.amazonaws.com/token`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await response.json();

    // Handle pending/slow_down/errors
    if (!response.ok || data.error) {
      return {
        success: false,
        error: data.error,
        errorDescription: data.error_description,
        pending: data.error === "authorization_pending" || data.error === "slow_down",
      };
    }

    return {
      success: true,
      tokens: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
        tokenType: data.tokenType,
      },
    };
  }

  /**
   * Build Google/GitHub social login URL
   * Returns authorization URL for manual callback flow
   * Uses kiro:// custom protocol as required by AWS Cognito whitelist
   */
  buildSocialLoginUrl(provider, codeChallenge, state) {
    const idp = provider === "google" ? "Google" : "Github";
    // AWS Cognito only whitelists kiro:// protocol, not localhost
    const redirectUri = "kiro://kiro.kiroAgent/authenticate-success";
    return `${KIRO_AUTH_SERVICE}/login?idp=${idp}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}&prompt=select_account`;
  }

  /**
   * Exchange authorization code for tokens (Social Login)
   * Must use same redirect_uri as authorization request
   */
  async exchangeSocialCode(code, codeVerifier) {
    // Must match the redirect_uri used in buildSocialLoginUrl
    const redirectUri = "kiro://kiro.kiroAgent/authenticate-success";

    const response = await fetch(`${KIRO_AUTH_SERVICE}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn || 3600,
    };
  }

  /**
   * Refresh token using refresh token
   */
  async refreshToken(refreshToken, providerSpecificData = {}) {
    const { authMethod, clientId, clientSecret, region } = providerSpecificData;

    // AWS SSO OIDC refresh (Builder ID or IDC)
    if (clientId && clientSecret) {
      const safeRegion = region || "us-east-1";
      assertValidAwsRegion(safeRegion);
      const endpoint = `https://oidc.${safeRegion}.amazonaws.com/token`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          clientSecret,
          refreshToken,
          grantType: "refresh_token",
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
      }

      const data = await response.json();
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshToken,
        profileArn: data.profileArn,
        expiresIn: data.expiresIn,
      };
    }

    // Social auth refresh (Google/GitHub)
    const response = await fetch(`${KIRO_AUTH_SERVICE}/refreshToken`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn || 3600,
    };
  }

  /**
   * Validate and import refresh token
   */
  async validateImportToken(refreshToken) {
    // Validate token format
    if (!refreshToken.startsWith("aorAAAAAG")) {
      throw new Error("Invalid token format. Token should start with aorAAAAAG...");
    }

    // Try to refresh to validate
    try {
      const result = await this.refreshToken(refreshToken);
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || refreshToken,
        profileArn: result.profileArn,
        expiresIn: result.expiresIn,
        authMethod: "imported",
      };
    } catch (error) {
      throw new Error(`Token validation failed: ${error.message}`);
    }
  }

  /**
   * List available CodeWhisperer profiles for a token (or API key) and return
   * the best-matching profileArn. AWS SSO OIDC logins return no profileArn, so
   * it must be fetched separately — the same call works for API-key auth.
   * Accepts both `arn` and `profileArn` response field names (the API-key
   * JSON-1.0 surface returns `arn`).
   */
  async listAvailableProfiles(accessToken, region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://codewhisperer.${region}.amazonaws.com`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      body: JSON.stringify({ maxResults: 10 }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list profiles: ${error}`);
    }

    const data = await response.json();
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    const arnOf = (p) => p?.arn || p?.profileArn || null;
    const match = profiles.find((p) => arnOf(p)?.split(":")[3] === region) || profiles[0];
    return arnOf(match);
  }

  /**
   * Validate an API-key credential against Kiro's management gateway — the only
   * surface that accepts a raw long-lived API key as a bearer token (the AWS
   * CodeWhisperer/Q hosts reject it). API keys have no refresh token, so the
   * only way to validate one is an authenticated call. The key's resources may
   * live in any region, so probe the common ones and keep the first that
   * responds; that region is stored so the quota panel targets the right host.
   * Returns a credential object ready to persist with authMethod="api_key".
   */
  async validateApiKey(apiKey, region = "us-east-1") {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw new Error("API key is required");
    }
    const trimmed = apiKey.trim();

    const candidates = [region, "us-east-1", "eu-central-1", "ap-southeast-1"]
      .filter((r, i, arr) => r && arr.indexOf(r) === i);

    const params = new URLSearchParams({
      isEmailRequired: "true",
      origin: "AI_EDITOR",
      resourceType: "AGENTIC_REQUEST",
    });

    let lastError = "unknown";
    for (const rg of candidates) {
      assertValidAwsRegion(rg);
      try {
        const response = await fetch(
          `https://management.${rg}.kiro.dev/getUsageLimits?${params.toString()}`,
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${trimmed}`,
              "TokenType": "API_KEY",
              "Accept": "application/json",
            },
          }
        );
        if (response.ok) {
          let email = null;
          try {
            const data = await response.json();
            email = data?.userInfo?.email || null;
          } catch {
            // Response body isn't required for validation
          }
          return {
            accessToken: trimmed,
            refreshToken: null,
            profileArn: null,
            region: rg,
            email,
            authMethod: "api_key",
          };
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error.message;
      }
    }

    throw new Error(`API key validation failed: ${lastError}`);
  }

  /**
   * List available models from CodeWhisperer API
   */
  async listAvailableModels(accessToken, profileArn) {
    const endpoint = "https://codewhisperer.us-east-1.amazonaws.com";
    const target = "AmazonCodeWhispererService.ListAvailableModels";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": target,
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      body: JSON.stringify({
        origin: "AI_EDITOR",
        profileArn,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list models: ${error}`);
    }

    const data = await response.json();
    return (data.models || []).map(m => ({
      id: m.modelId,
      name: m.modelName || m.modelId,
      description: m.description,
      rateMultiplier: m.rateMultiplier,
      rateUnit: m.rateUnit,
      maxInputTokens: m.tokenLimits?.maxInputTokens || 0,
    }));
  }

  /**
   * Fetch user email from access token (optional, for display)
   */
  extractEmailFromJWT(accessToken) {
    try {
      const parts = accessToken.split(".");
      if (parts.length !== 3) return null;

      // Decode payload (add padding if needed)
      let payload = parts[1];
      while (payload.length % 4) {
        payload += "=";
      }

      const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      return decoded.email || decoded.preferred_username || decoded.sub;
    } catch {
      return null;
    }
  }
}
