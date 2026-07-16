import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { resolveKiroModel } from "../config/kiroConstants.js";
import { v4 as uuidv4 } from "uuid";
import { refreshKiroToken } from "../services/tokenRefresh.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";

/**
 * KiroExecutor - Executor for Kiro AI (AWS CodeWhisperer)
 * Uses AWS CodeWhisperer streaming API with AWS EventStream binary format
 */
export class KiroExecutor extends BaseExecutor {
  constructor() {
    super("kiro", PROVIDERS.kiro);
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      ...this.config.headers,
      "Amz-Sdk-Request": "attempt=1; max=3",
      "Amz-Sdk-Invocation-Id": uuidv4()
    };

    // API-key auth: the key is stored as accessToken and sent as a bearer token
    // exactly like an OAuth access token, but with an extra `tokentype: API_KEY`
    // header so CodeWhisperer treats it as a long-lived API key rather than an
    // OIDC/social access token. Mirrors the Kiro IDE headless-auth behavior.
    // Enterprise / Microsoft Entra (external_idp) tokens are OAuth access tokens,
    // but CodeWhisperer requires TokenType=EXTERNAL_IDP to bind them to profiles.
    const authMethod = credentials?.providerSpecificData?.authMethod;
    const isApiKey = authMethod === "api_key";
    const isExternalIdp = authMethod === "external_idp";

    const apiKey = credentials?.apiKey || (isApiKey ? credentials?.accessToken : null);
    if (isApiKey && apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      headers["tokentype"] = "API_KEY";
    } else if (credentials.accessToken) {
      headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      if (isExternalIdp) {
        headers["TokenType"] = "EXTERNAL_IDP";
      }
    }

    return headers;
  }

  /**
   * Resolve the AWS region for this connection. IDC connections persist the
   * org region in providerSpecificData.region (from the login form); other
   * methods carry it in the profileArn (arn:aws:codewhisperer:{region}:...).
   * Falls back to us-east-1 (Builder ID / social home region).
   */
  resolveRegion(credentials) {
    const REGION_RE = /^[a-z]{2}-[a-z]+-\d{1,2}$/;
    const psd = credentials?.providerSpecificData || {};
    // The profileArn is the source of truth for where inference runs
    // (arn:aws:codewhisperer:{region}:...). Prefer it. Fall back to the region
    // stored at login (IdC home region) and finally us-east-1.
    const arn = typeof psd.profileArn === "string" ? psd.profileArn : "";
    const arnRegion = arn.split(":")[3];
    if (arnRegion && REGION_RE.test(arnRegion)) return arnRegion;
    const fromPsd = typeof psd.region === "string" ? psd.region.trim() : "";
    if (REGION_RE.test(fromPsd)) return fromPsd;
    return "us-east-1";
  }

  /**
   * Auth-aware + region-aware endpoint ordering.
   *
   * API-key Kiro connections store a raw CodeWhisperer credential (validated
   * against codewhisperer.us-east-1.amazonaws.com via ListAvailableProfiles).
   * The Kiro IDE gateway (runtime.*.kiro.dev) expects Kiro OIDC/social tokens
   * and rejects an `tokentype: API_KEY` token with 401/403 — which
   * BaseExecutor.execute() returns immediately (only 429 / network errors fall
   * through to the next host). So for api-key auth we must try the *.amazonaws.com
   * CodeWhisperer hosts FIRST, mirroring the Kiro-Go reference fork which never
   * routes api-key traffic through kiro.dev. External IdP enterprise tokens also
   * use the CodeWhisperer surface, with the `TokenType: EXTERNAL_IDP` header.
   * Other OAuth methods keep the default order (kiro.dev first) since their
   * tokens are what that gateway accepts.
   *
   * Region: the registry baseUrls are pinned to us-east-1. For accounts whose
   * home region is different (e.g. IDC in eu-central-1), the regional
   * CodeWhisperer/Q endpoints are the correct targets, so we rewrite the
   * *.amazonaws.com hosts to the connection's region and try them first (the
   * us-east-1 kiro.dev gateway does not serve non-us-east-1 profiles).
   */
  getOrderedBaseUrls(credentials) {
    const baseUrls = this.getBaseUrls();
    const authMethod = credentials?.providerSpecificData?.authMethod;

    // API-key (ksk_) auth authenticates against Kiro's own runtime gateway
    // (runtime.{region}.kiro.dev), region-bound. The AWS CodeWhisperer/Q hosts
    // reject a ksk_ API key (DNS-less regional endpoints / "subscription does
    // not support this application"), so the region-correct kiro.dev host must
    // come FIRST and be region-substituted too — not just the amazonaws hosts.
    // Hitting us-east-1 with a non-us-east-1 key returns 403 "bearer token
    // included in the request is invalid".
    if (authMethod === "api_key") {
      const region = this.resolveRegion(credentials);
      const urls = region !== "us-east-1"
        ? baseUrls.map((u) => u.replace("us-east-1", region))
        : baseUrls;
      const kiro = urls.filter((u) => u.includes("kiro.dev"));
      const others = urls.filter((u) => !u.includes("kiro.dev"));
      return kiro.length > 0 ? [...kiro, ...others] : urls;
    }

    // IAM Identity Center (idc) tokens are AWS SSO access tokens — the same
    // family as external_idp. The kiro.dev gateway rejects them with
    // 403 "bearer token invalid", so they must hit the CodeWhisperer
    // *.amazonaws.com surface, in the region the token was minted in (upstream
    // v0.5.18 "route IdC auth to regional CodeWhisperer surface").
    const isCodeWhispererSurface =
      authMethod === "external_idp" || authMethod === "idc";
    const region = this.resolveRegion(credentials);
    const regional = region !== "us-east-1";

    // Rewrite only the AWS-native hosts to the credential's region. The
    // kiro.dev gateway is us-east-1 only, so it is left untouched.
    const urls = regional
      ? baseUrls.map((u) =>
          u.includes("amazonaws.com") ? u.replace("us-east-1", region) : u,
        )
      : baseUrls;

    // Prefer the *.amazonaws.com hosts first for the CodeWhisperer surface
    // (api-key / external IdP / IdC) or any non-default region (the kiro.dev
    // gateway only accepts us-east-1 OAuth/social tokens).
    if (!isCodeWhispererSurface && !regional) return urls;
    const amazon = urls.filter((u) => u.includes("amazonaws.com"));
    const others = urls.filter((u) => !u.includes("amazonaws.com"));
    return amazon.length > 0 ? [...amazon, ...others] : urls;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const baseUrls = this.getOrderedBaseUrls(credentials);
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  transformRequest(model, body, stream, credentials) {
    return body;
  }

  /**
   * Kiro execute — delegate to BaseExecutor for endpoint fallback + retry, then
   * transform the binary AWS EventStream into OpenAI-shaped SSE on success.
   *
   * BaseExecutor.execute() walks config.baseUrls (runtime.us-east-1.kiro.dev →
   * codewhisperer → q) advancing to the next host on 429 (shouldRetry) and on
   * network/5xx errors, while tryRetry handles in-place retries per `retry: {429: 2}`.
   * Note: api-key connections reorder these so the *.amazonaws.com hosts come
   * first — see getOrderedBaseUrls/buildUrl above.
   * Note: the baseUrls are alternate surfaces of one regional service, so rotation
   * is edge-level failover — it does not grant fresh 429 quota. Per-account 429
   * spreading is handled upstream by account rotation in sse/handlers/chat.js.
   *
   * Errors are returned untransformed so the upstream handler can read the body,
   * classify the status, and trigger account fallback/cooldown.
   */
  async execute(args) {
    const result = await super.execute(args);
    if (result?.response?.ok) {
      result.response = this.transformEventStreamToSSE(result.response, args.model);
    }
    return result;
  }

  /**
   * Transform AWS EventStream binary response to SSE text stream
   * Using TransformStream instead of ReadableStream.pull() to avoid Workers timeout
   */
  transformEventStreamToSSE(response, model) {
    let buffer = new Uint8Array(0);
    let chunkIndex = 0;
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const capabilityModel = resolveKiroModel(model).upstream;
    const contextWindow = getCapabilitiesForModel("kiro", capabilityModel).contextWindow || 200000;
    const state = {
      endDetected: false,
      finishEmitted: false,
      hasToolCalls: false,
      hasReasoningContent: false,
      reasoningChunkCount: 0,
      toolCallIndex: 0,
      seenToolIds: new Map(),
      inThinking: false
    };

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
             // Track output so we can emit a keepalive if this frame yields no chunk.
        const enqueueCountBefore = chunkIndex;
        // Append to buffer
        const newBuffer = new Uint8Array(buffer.length + chunk.length);
        newBuffer.set(buffer);
        newBuffer.set(chunk, buffer.length);
        buffer = newBuffer;

        // Parse events from buffer
        let iterations = 0;
        const maxIterations = 1000;
        while (buffer.length >= 16 && iterations < maxIterations) {
          iterations++;
          const view = new DataView(buffer.buffer, buffer.byteOffset);
          const totalLength = view.getUint32(0, false);

          if (totalLength < 16 || totalLength > buffer.length || buffer.length < totalLength) break;

          const eventData = buffer.slice(0, totalLength);
          buffer = buffer.slice(totalLength);

          const event = parseEventFrame(eventData);
          if (!event) continue;

          const eventType = event.headers[":event-type"] || "";

          // Track total content length for token estimation
          if (!state.totalContentLength) state.totalContentLength = 0;
          if (!state.contextUsagePercentage) state.contextUsagePercentage = 0;

          // Handle assistantResponseEvent
          if (eventType === "assistantResponseEvent" && event.payload?.content) {
            let content = event.payload.content;

            // Kiro Claude models can leak <thinking> blocks into the content stream.
            // We strip these literal tags to prevent duplication, as the reasoning 
            // is already routed correctly via reasoningContentEvent.
            if (state.inThinking) {
              if (content.includes("</thinking>")) {
                state.inThinking = false;
                const after = content.split("</thinking>").slice(1).join("</thinking>");
                content = after.startsWith("\n") ? after.substring(1) : after;
              } else {
                content = ""; // Drop entirely while inside thinking block
              }
            } else if (content.includes("<thinking>")) {
              state.inThinking = true;
              if (content.includes("</thinking>")) {
                state.inThinking = false;
                const before = content.split("<thinking>")[0];
                const after = content.split("</thinking>").slice(1).join("</thinking>");
                content = before + (after.startsWith("\n") ? after.substring(1) : after);
              } else {
                content = content.split("<thinking>")[0];
              }
            }

            if (!content && state.hasReasoningContent) {
              // If we stripped everything, skip emitting an empty content chunk
              continue;
            }

            state.totalContentLength += content.length;

            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: chunkIndex === 0
                  ? { role: "assistant", content }
                  : { content },
                finish_reason: null
              }]
            };
            chunkIndex++;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle reasoningContentEvent (Kiro thinking / reasoning)
          // Kiro returns reasoning as a separate event when the request system
          // prompt contains <thinking_mode>enabled</thinking_mode>. Surface it
          // as OpenAI delta.reasoning_content so downstream translators can map
          // it back to Claude thinking blocks / Anthropic reasoning, etc.
          if (eventType === "reasoningContentEvent") {
            const reasoning = event.payload?.reasoningContentEvent || event.payload || {};
            const reasoningText = (typeof reasoning === "string")
              ? reasoning
              : (reasoning.text || reasoning.content || "");
            if (reasoningText) {
              state.hasReasoningContent = true;
              state.totalContentLength += reasoningText.length;

              const reasoningDelta = state.reasoningChunkCount === 0 && chunkIndex === 0
                ? { role: "assistant", reasoning_content: reasoningText }
                : { reasoning_content: reasoningText };

              const chunk = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: reasoningDelta,
                  finish_reason: null
                }]
              };
              chunkIndex++;
              state.reasoningChunkCount++;
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          }

          // Handle codeEvent
          if (eventType === "codeEvent" && event.payload?.content) {
            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: { content: event.payload.content },
                finish_reason: null
              }]
            };
            chunkIndex++;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle toolUseEvent
          if (eventType === "toolUseEvent" && event.payload) {
            state.hasToolCalls = true;
            const toolUse = event.payload;
            const toolUses = Array.isArray(toolUse) ? toolUse : [toolUse];

            for (const singleToolUse of toolUses) {
              const toolCallId = singleToolUse.toolUseId || `call_${Date.now()}`;
              const toolName = singleToolUse.name || "";
              const toolInput = singleToolUse.input;

              let toolIndex;
              const isNewTool = !state.seenToolIds.has(toolCallId);

              if (isNewTool) {
                toolIndex = state.toolCallIndex++;
                state.seenToolIds.set(toolCallId, toolIndex);

                const startChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      ...(chunkIndex === 0 ? { role: "assistant" } : {}),
                      tool_calls: [{
                        index: toolIndex,
                        id: toolCallId,
                        type: "function",
                        function: {
                          name: toolName,
                          arguments: ""
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                chunkIndex++;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(startChunk)}\n\n`));
              } else {
                toolIndex = state.seenToolIds.get(toolCallId);
              }

              if (toolInput !== undefined) {
                let argumentsStr;

                if (typeof toolInput === 'string') {
                  argumentsStr = toolInput;
                } else if (typeof toolInput === 'object') {
                  argumentsStr = JSON.stringify(toolInput);
                } else {
                  continue;
                }

                const argsChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolIndex,
                        function: {
                          arguments: argumentsStr
                        }
                      }]
                    },
                    finish_reason: null
                  }]
                };
                chunkIndex++;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(argsChunk)}\n\n`));
              }
            }
          }

          // Handle messageStopEvent
          if (eventType === "messageStopEvent") {
            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: state.hasToolCalls ? "tool_calls" : "stop"
              }]
            };
            state.finishEmitted = true;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // Handle contextUsageEvent to extract contextUsagePercentage
          if (eventType === "contextUsageEvent" && event.payload?.contextUsagePercentage) {
            state.contextUsagePercentage = event.payload.contextUsagePercentage;
            // Mark that we received context usage event
            state.hasContextUsage = true;
          }

          // Handle meteringEvent - mark that we received it
          if (eventType === "meteringEvent") {
            state.hasMeteringEvent = true;
          }

          // Handle metricsEvent for token usage
          if (eventType === "metricsEvent") {
            // Extract usage data from metricsEvent payload
            const metrics = event.payload?.metricsEvent || event.payload;
            if (metrics && typeof metrics === 'object') {
              const inputTokens = metrics.inputTokens || 0;
              const outputTokens = metrics.outputTokens || 0;
              // ponytail: Amazon Q upstream does not expose cache fields today,
              // but pick up cache_read_input_tokens / cache_creation_input_tokens
              // if the event shape grows them so cost tracking stays accurate.
              const cachedTokens = metrics.cacheReadInputTokens || metrics.cache_read_input_tokens || 0;
              const cacheCreationInputTokens = metrics.cacheCreationInputTokens || metrics.cache_creation_input_tokens || 0;

              if (inputTokens > 0 || outputTokens > 0) {
                state.usage = {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens
                };
                // Kiro is Claude-backed: inputTokens EXCLUDES cache (Claude convention),
                // not inclusive like OpenAI's cached_tokens. Emit cache_read_input_tokens
                // (not cached_tokens) so canonicalizeUsage takes the Claude fold path and
                // correctly adds cache back into prompt_tokens instead of undercharging.
                if (cachedTokens > 0) state.usage.cache_read_input_tokens = cachedTokens;
                if (cacheCreationInputTokens > 0) state.usage.cache_creation_input_tokens = cacheCreationInputTokens;
              }
            }
          }

          // Emit final chunk only after receiving BOTH meteringEvent AND contextUsageEvent
          if (state.hasMeteringEvent && state.hasContextUsage && !state.finishEmitted) {
            state.finishEmitted = true;

            // Estimate tokens if not available from events
            if (!state.usage) {
              // Estimate output tokens from content length
              const estimatedOutputTokens = state.totalContentLength > 0
                ? Math.max(1, Math.floor(state.totalContentLength / 4))
                : 0;

              // Estimate input tokens from contextUsagePercentage
              const estimatedInputTokens = state.contextUsagePercentage > 0
                ? Math.floor(state.contextUsagePercentage * contextWindow / 100)
                : 0;

              state.usage = {
                prompt_tokens: estimatedInputTokens,
                completion_tokens: estimatedOutputTokens,
                total_tokens: estimatedInputTokens + estimatedOutputTokens
              };
            }

            const finishChunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: state.hasToolCalls ? "tool_calls" : "stop"
              }]
            };

            // Include usage in final chunk if available
            if (state.usage) {
              finishChunk.usage = state.usage;
            }

            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
          }
        }

        if (iterations >= maxIterations) {
          console.warn("[Kiro] Max iterations reached in event parsing");
        }

        // No client chunk produced this frame — emit an SSE comment keepalive
                // so the stall watchdog sees upstream activity (ignored by parser/client).
                if (chunkIndex === enqueueCountBefore && !state.finishEmitted) {
                  controller.enqueue(new TextEncoder().encode(": ka\n\n"));
                }
      },

      flush(controller) {
        // Emit finish chunk if not already sent
        if (!state.finishEmitted) {
          state.finishEmitted = true;
          const finishChunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: state.hasToolCalls ? "tool_calls" : "stop"
            }]
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
        }

        // Send final done message
        controller.enqueue(new TextEncoder().encode(SSE_DONE));
      }
    });

    // Pipe response body through transform stream
    if (!response.body) {
      return new Response(SSE_DONE, { status: response.status, headers: { "Content-Type": "text/event-stream" } });
    }
    const transformedStream = response.body.pipeThrough(transformStream);

    return new Response(transformedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: { ...SSE_HEADERS }
    });
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    try {
      // Use centralized refreshKiroToken function (handles both AWS SSO OIDC and Social Auth)
      const result = await refreshKiroToken(
        credentials.refreshToken,
        credentials.providerSpecificData,
        log,
        proxyOptions
      );

      return result;
    } catch (error) {
      log?.error?.("TOKEN", `Kiro refresh error: ${error.message}`);
      return null;
    }
  }
}

/**
 * Parse AWS EventStream frame
 */
function parseEventFrame(data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset);
    const headersLength = view.getUint32(4, false);

    // Parse headers
    const headers = {};
    let offset = 12; // After prelude
    const headerEnd = 12 + headersLength;

    while (offset < headerEnd && offset < data.length) {
      const nameLen = data[offset];
      offset++;
      if (offset + nameLen > data.length) break;

      const name = new TextDecoder().decode(data.slice(offset, offset + nameLen));
      offset += nameLen;

      const headerType = data[offset];
      offset++;

      if (headerType === 7) { // String type
        const valueLen = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        if (offset + valueLen > data.length) break;

        const value = new TextDecoder().decode(data.slice(offset, offset + valueLen));
        offset += valueLen;
        headers[name] = value;
      } else {
        break;
      }
    }

    // Parse payload
    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4; // Exclude message CRC

    let payload = null;
    if (payloadEnd > payloadStart) {
      const payloadStr = new TextDecoder().decode(data.slice(payloadStart, payloadEnd));

      // Skip empty or whitespace-only payloads
      if (!payloadStr || !payloadStr.trim()) {
        return { headers, payload: null };
      }

      try {
        payload = JSON.parse(payloadStr);
      } catch (parseError) {
        // Log parse error for debugging
        console.warn(`[Kiro] Failed to parse payload: ${parseError.message} | payload: ${payloadStr.substring(0, 100)}`);
        payload = { raw: payloadStr };
      }
    }

    return { headers, payload };
  } catch {
    return null;
  }
}

export default KiroExecutor;
