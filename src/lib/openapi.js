const errorResponse = {
  type: "object",
  properties: {
    error: {
      oneOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            message: { type: "string" },
            type: { type: "string" },
            code: { type: "string" },
          },
          additionalProperties: true,
        },
      ],
    },
  },
  additionalProperties: true,
};

const modelObject = {
  type: "object",
  properties: {
    id: { type: "string", example: "openai/gpt-4o-mini" },
    object: { type: "string", example: "model" },
    owned_by: { type: "string", example: "openai" },
    kind: { type: "string", example: "llm" },
  },
  additionalProperties: true,
};

const messageObject = {
  type: "object",
  required: ["role", "content"],
  properties: {
    role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
    content: {
      oneOf: [
        { type: "string" },
        {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      ],
    },
    name: { type: "string" },
    tool_call_id: { type: "string" },
  },
  additionalProperties: true,
};

const jsonObject = {
  type: "object",
  additionalProperties: true,
};

const ownerUserObject = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    budgetUsd: { type: "number", nullable: true },
    isActive: { type: "boolean" },
    configured: { type: "boolean" },
    createdAt: { type: "string", nullable: true, format: "date-time" },
    updatedAt: { type: "string", nullable: true, format: "date-time" },
  },
  additionalProperties: true,
};

const ownerUserStateObject = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    budgetUsd: { type: "number", nullable: true },
    spentUsd: { type: "number" },
    remainingUsd: { type: "number", nullable: true },
    isActive: { type: "boolean" },
    configured: { type: "boolean" },
    keyCount: { type: "integer" },
    requestCount: { type: "integer" },
    createdAt: { type: "string", nullable: true, format: "date-time" },
    updatedAt: { type: "string", nullable: true, format: "date-time" },
  },
  additionalProperties: true,
};

const apiKeyObject = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    key: { type: "string", description: "Raw API key. Returned in full by every read endpoint — not masked." },
    owner: { type: "string", format: "email", nullable: true },
    userEmail: { type: "string", format: "email", nullable: true, description: "Alias of owner. Computed at read time." },
    machineId: { type: "string", nullable: true },
    isActive: { type: "boolean" },
    createdAt: { type: "string", format: "date-time", nullable: true },
  },
  additionalProperties: true,
};

const authResponses = {
  401: {
    description: "Missing, invalid, or paused API key.",
    content: { "application/json": { schema: errorResponse } },
  },
  403: {
    description: "The API key is valid but the owner budget or account policy blocks the request.",
    content: { "application/json": { schema: errorResponse } },
  },
};

const adminSecurity = [{ adminBearerAuth: [] }, { adminApiKeyHeader: [] }];

const serverErrorResponse = {
  500: {
    description: "Server error.",
    content: { "application/json": { schema: errorResponse } },
  },
};

function jsonRequest(schema, example) {
  return {
    required: true,
    content: {
      "application/json": {
        schema,
        examples: example ? { default: { value: example } } : undefined,
      },
    },
  };
}

function jsonResponse(description, schema = jsonObject, example = undefined) {
  return {
    description,
    content: {
      "application/json": {
        schema,
        examples: example ? { default: { value: example } } : undefined,
      },
    },
  };
}

export function getOpenApiSpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "9Router External API",
      version: "1.0.0",
      description:
        "OpenAI-compatible API for connecting external apps to 9Router as the backend AI router. Use an API key from the 9Router dashboard with the Authorization: Bearer <api-key> header.",
    },
    servers: [
      { url: "/v1", description: "Preferred OpenAI-compatible base path" },
      { url: "/api/v1", description: "Next.js API base path alias" },
    ],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    tags: [
      { name: "Models", description: "Model discovery and metadata." },
      { name: "Chat", description: "OpenAI, Responses, Claude, and Ollama-compatible routing." },
      { name: "Media", description: "Images, text-to-speech, speech-to-text, and embeddings." },
      { name: "Web", description: "Search and web page extraction tools routed through configured providers." },
      { name: "Admin", description: "Sidebar management APIs for usage, users, API keys, models, and pricing. Requires ADMIN_API_KEY from .env, sent as Authorization: Bearer <ADMIN_API_KEY> or x-admin-api-key. Every admin path also accepts an unauthenticated OPTIONS preflight (returns 204 with permissive CORS headers); preflight is intentionally not modeled per-path in this spec." },
    ],
    paths: {
      "/models": {
        get: {
          tags: ["Models"],
          operationId: "listModels",
          summary: "List available LLM models",
          description:
            "Returns the model IDs external apps should send in request bodies. IDs include provider aliases, custom models, and combos configured in 9Router.",
          responses: {
            200: jsonResponse("OpenAI-compatible model list.", {
              type: "object",
              properties: {
                object: { type: "string", example: "list" },
                data: { type: "array", items: modelObject },
              },
            }),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/models/{kind}": {
        get: {
          tags: ["Models"],
          operationId: "listModelsByKind",
          summary: "List models by capability",
          parameters: [
            {
              name: "kind",
              in: "path",
              required: true,
              schema: {
                type: "string",
                enum: ["image", "tts", "stt", "embedding", "image-to-text", "web"],
              },
            },
          ],
          responses: {
            200: jsonResponse("Filtered model list.", {
              type: "object",
              properties: {
                object: { type: "string", example: "list" },
                data: { type: "array", items: modelObject },
              },
            }),
            404: jsonResponse("Unknown model kind.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/models/info": {
        get: {
          tags: ["Models"],
          operationId: "getModelInfo",
          summary: "Get metadata for one model",
          parameters: [
            {
              name: "id",
              in: "query",
              required: true,
              schema: { type: "string" },
              example: "openai/gpt-4o-mini",
            },
          ],
          responses: {
            200: jsonResponse("Model metadata.", jsonObject),
            400: jsonResponse("Missing id query parameter.", errorResponse),
            404: jsonResponse("Model not found.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/chat/completions": {
        post: {
          tags: ["Chat"],
          operationId: "createChatCompletion",
          summary: "Create a chat completion",
          description:
            "OpenAI-compatible chat endpoint. The model may be a provider model, alias, or combo configured in 9Router. Streaming is supported with stream: true.",
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["model", "messages"],
              properties: {
                model: { type: "string", example: "openai/gpt-4o-mini" },
                messages: { type: "array", items: messageObject },
                stream: { type: "boolean", default: false },
                temperature: { type: "number" },
                max_tokens: { type: "integer" },
                tools: { type: "array", items: jsonObject },
                tool_choice: { oneOf: [{ type: "string" }, jsonObject] },
              },
              additionalProperties: true,
            },
            {
              model: "openai/gpt-4o-mini",
              messages: [{ role: "user", content: "Say hello from 9Router." }],
              stream: false,
            }
          ),
          responses: {
            200: {
              description: "Chat completion JSON or text/event-stream when stream is true.",
              content: {
                "application/json": { schema: jsonObject },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            400: jsonResponse("Invalid request body.", errorResponse),
            404: jsonResponse("Model or provider is not configured.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/responses": {
        post: {
          tags: ["Chat"],
          operationId: "createResponse",
          summary: "Create an OpenAI Responses API response",
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["model", "input"],
              properties: {
                model: { type: "string", example: "openai/gpt-4o-mini" },
                input: {
                  oneOf: [
                    { type: "string" },
                    { type: "array", items: jsonObject },
                  ],
                },
                stream: { type: "boolean", default: false },
                tools: { type: "array", items: jsonObject },
                reasoning: { type: "object", additionalProperties: true },
              },
              additionalProperties: true,
            },
            {
              model: "openai/gpt-4o-mini",
              input: "Write one sentence about API routing.",
            }
          ),
          responses: {
            200: {
              description: "Responses API JSON or text/event-stream when stream is true.",
              content: {
                "application/json": { schema: jsonObject },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            400: jsonResponse("Invalid request body.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/responses/compact": {
        post: {
          tags: ["Chat"],
          operationId: "compactResponseContext",
          summary: "Compact conversation context",
          description: "Uses the configured chat pipeline with an internal compact signal.",
          requestBody: jsonRequest(jsonObject, {
            model: "openai/gpt-4o-mini",
            input: "Compact this conversation context.",
          }),
          responses: {
            200: jsonResponse("Compacted response.", jsonObject),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/messages": {
        post: {
          tags: ["Chat"],
          operationId: "createAnthropicMessage",
          summary: "Create a Claude-format message",
          description: "Anthropic-compatible messages endpoint. 9Router translates and routes the request to the selected provider.",
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["model", "messages"],
              properties: {
                model: { type: "string", example: "anthropic/claude-sonnet-4" },
                max_tokens: { type: "integer", example: 1024 },
                messages: { type: "array", items: messageObject },
                stream: { type: "boolean", default: false },
              },
              additionalProperties: true,
            },
            {
              model: "anthropic/claude-sonnet-4",
              max_tokens: 512,
              messages: [{ role: "user", content: "Hello from a Claude-compatible client." }],
            }
          ),
          responses: {
            200: jsonResponse("Claude-compatible response.", jsonObject),
            400: jsonResponse("Invalid request body.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/messages/count_tokens": {
        post: {
          tags: ["Chat"],
          operationId: "countMessageTokens",
          summary: "Estimate Claude-format input tokens",
          requestBody: jsonRequest(
            {
              type: "object",
              properties: {
                messages: { type: "array", items: messageObject },
              },
              additionalProperties: true,
            },
            { messages: [{ role: "user", content: "Count me." }] }
          ),
          responses: {
            200: jsonResponse("Estimated token count.", {
              type: "object",
              properties: { input_tokens: { type: "integer" } },
            }),
            400: jsonResponse("Invalid request body.", errorResponse),
            ...authResponses,
          },
        },
      },
      "/api/chat": {
        post: {
          tags: ["Chat"],
          operationId: "createOllamaChat",
          summary: "Create an Ollama-compatible chat response",
          requestBody: jsonRequest(jsonObject, {
            model: "openai/gpt-4o-mini",
            messages: [{ role: "user", content: "Hello from an Ollama-style client." }],
          }),
          responses: {
            200: jsonResponse("Ollama-compatible response.", jsonObject),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/embeddings": {
        post: {
          tags: ["Media"],
          operationId: "createEmbedding",
          summary: "Create embeddings",
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["model", "input"],
              properties: {
                model: { type: "string", example: "openai/text-embedding-3-small" },
                input: {
                  oneOf: [
                    { type: "string" },
                    { type: "array", items: { type: "string" } },
                  ],
                },
              },
              additionalProperties: true,
            },
            { model: "openai/text-embedding-3-small", input: "Text to embed." }
          ),
          responses: {
            200: jsonResponse("Embedding response.", jsonObject),
            400: jsonResponse("Invalid request body.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/images/generations": {
        post: {
          tags: ["Media"],
          operationId: "createImage",
          summary: "Generate images",
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["model", "prompt"],
              properties: {
                model: { type: "string", example: "openai/dall-e-3" },
                prompt: { type: "string" },
                n: { type: "integer", default: 1 },
                size: { type: "string", example: "1024x1024" },
              },
              additionalProperties: true,
            },
            { model: "openai/dall-e-3", prompt: "A clean API router dashboard", n: 1, size: "1024x1024" }
          ),
          responses: {
            200: jsonResponse("Image generation response.", jsonObject),
            400: jsonResponse("Invalid request body.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/audio/speech": {
        post: {
          tags: ["Media"],
          operationId: "createSpeech",
          summary: "Create speech audio",
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["model", "input", "voice"],
              properties: {
                model: { type: "string", example: "openai/tts-1" },
                input: { type: "string" },
                voice: { type: "string", example: "alloy" },
                response_format: { type: "string", example: "mp3" },
              },
              additionalProperties: true,
            },
            { model: "openai/tts-1", input: "Hello from 9Router.", voice: "alloy" }
          ),
          responses: {
            200: {
              description: "Audio bytes or provider JSON depending on the provider.",
              content: {
                "audio/mpeg": { schema: { type: "string", format: "binary" } },
                "application/json": { schema: jsonObject },
              },
            },
            400: jsonResponse("Invalid request body.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/audio/transcriptions": {
        post: {
          tags: ["Media"],
          operationId: "createTranscription",
          summary: "Transcribe audio",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["model", "file"],
                  properties: {
                    model: { type: "string", example: "openai/whisper-1" },
                    file: { type: "string", format: "binary" },
                    language: { type: "string", example: "en" },
                    response_format: { type: "string", example: "json" },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            200: jsonResponse("Transcription response.", jsonObject),
            400: jsonResponse("Invalid request body.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/audio/voices": {
        get: {
          tags: ["Media"],
          operationId: "listVoices",
          summary: "List TTS voices for a provider",
          parameters: [
            {
              name: "provider",
              in: "query",
              required: true,
              schema: {
                type: "string",
                enum: ["elevenlabs", "deepgram", "inworld", "edge-tts", "local-device"],
              },
            },
            {
              name: "lang",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "en",
            },
          ],
          responses: {
            200: jsonResponse("Voice list.", {
              type: "object",
              properties: {
                object: { type: "string", example: "list" },
                data: { type: "array", items: jsonObject },
              },
            }),
            400: jsonResponse("Invalid provider.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/search": {
        post: {
          tags: ["Web"],
          operationId: "searchWeb",
          summary: "Search the web",
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["model", "query"],
              properties: {
                model: { type: "string", example: "tavily/search" },
                query: { type: "string" },
                max_results: { type: "integer", default: 5 },
                country: { type: "string" },
                language: { type: "string" },
                time_range: { type: "string" },
              },
              additionalProperties: true,
            },
            { model: "tavily/search", query: "latest AI router patterns", max_results: 5 }
          ),
          responses: {
            200: jsonResponse("Search response.", jsonObject),
            400: jsonResponse("Invalid request body.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/web/fetch": {
        post: {
          tags: ["Web"],
          operationId: "fetchWebPage",
          summary: "Fetch and extract a web page",
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["model", "url"],
              properties: {
                model: { type: "string", example: "tavily/fetch" },
                url: { type: "string", format: "uri" },
                format: { type: "string", example: "markdown" },
                max_characters: { type: "integer" },
              },
              additionalProperties: true,
            },
            { model: "tavily/fetch", url: "https://example.com", format: "markdown" }
          ),
          responses: {
            200: jsonResponse("Fetch response.", jsonObject),
            400: jsonResponse("Invalid request body.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/admin/usage": {
        get: {
          tags: ["Admin"],
          operationId: "getAdminUsage",
          summary: "Get usage dashboard data",
          description: "Returns usage stats, chart data, recent logs, request details, and provider filters for the Usage sidebar menu. Out-of-range integer params are silently clamped — only an invalid `period` returns 400. When `period=all`, `chartPeriod` falls back to `60d` (chart has no \"all\" window).",
          security: adminSecurity,
          parameters: [
            { name: "period", in: "query", schema: { type: "string", enum: ["today", "24h", "7d", "30d", "60d", "all"], default: "7d" } },
            { name: "page", in: "query", schema: { type: "integer", default: 1, minimum: 1, maximum: 999999 } },
            { name: "pageSize", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
            { name: "logsLimit", in: "query", schema: { type: "integer", default: 200, minimum: 0, maximum: 500 } },
            { name: "provider", in: "query", schema: { type: "string" } },
            { name: "model", in: "query", schema: { type: "string" } },
            { name: "connectionId", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "startDate", in: "query", schema: { type: "string" } },
            { name: "endDate", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: jsonResponse(
              "Usage dashboard data.",
              {
                type: "object",
                properties: {
                  period: { type: "string", enum: ["today", "24h", "7d", "30d", "60d", "all"] },
                  chartPeriod: { type: "string", enum: ["today", "24h", "7d", "30d", "60d"] },
                  stats: jsonObject,
                  chart: jsonObject,
                  logs: { type: "array", items: jsonObject },
                  requestDetails: {
                    type: "object",
                    properties: {
                      details: { type: "array", items: jsonObject },
                      total: { type: "integer" },
                      page: { type: "integer" },
                      pageSize: { type: "integer" },
                    },
                    additionalProperties: true,
                  },
                  providers: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              }
            ),
            400: jsonResponse("Invalid period (only `period` returns 400; other params are clamped).", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/admin/users": {
        get: {
          tags: ["Admin"],
          operationId: "listAdminUsers",
          summary: "List sidebar users",
          security: adminSecurity,
          responses: {
            200: jsonResponse(
              "Users and budget state.",
              {
                type: "object",
                properties: {
                  users: { type: "array", items: ownerUserStateObject },
                },
              }
            ),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
        post: {
          tags: ["Admin"],
          operationId: "createAdminUser",
          summary: "Create or upsert a sidebar user",
          security: adminSecurity,
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["email", "budgetUsd"],
              properties: {
                email: { type: "string", format: "email" },
                budgetUsd: { type: "number", minimum: 0 },
                isActive: { type: "boolean", default: true },
              },
            },
            { email: "user@example.com", budgetUsd: 25, isActive: true }
          ),
          responses: {
            201: jsonResponse(
              "Created (or updated) user.",
              {
                type: "object",
                properties: { user: ownerUserObject },
              }
            ),
            400: jsonResponse("Invalid user payload.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/admin/users/{email}": {
        get: {
          tags: ["Admin"],
          operationId: "getAdminUser",
          summary: "Get one sidebar user",
          security: adminSecurity,
          parameters: [{ name: "email", in: "path", required: true, schema: { type: "string", format: "email" } }],
          responses: {
            200: jsonResponse(
              "User budget state.",
              {
                type: "object",
                properties: { user: ownerUserStateObject },
              }
            ),
            400: jsonResponse("Invalid email in path.", errorResponse),
            404: jsonResponse("User not found.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
        patch: {
          tags: ["Admin"],
          operationId: "updateAdminUser",
          summary: "Update a sidebar user (upsert)",
          description: "Upsert: if the email does not exist, the user is created. PATCH never returns 404.",
          security: adminSecurity,
          parameters: [{ name: "email", in: "path", required: true, schema: { type: "string", format: "email" } }],
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["budgetUsd"],
              properties: {
                budgetUsd: { type: "number", minimum: 0 },
                isActive: { type: "boolean", default: true },
              },
            },
            { budgetUsd: 50, isActive: true }
          ),
          responses: {
            200: jsonResponse(
              "Updated user.",
              {
                type: "object",
                properties: { user: ownerUserObject },
              }
            ),
            400: jsonResponse("Invalid user payload.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
        post: {
          tags: ["Admin"],
          operationId: "runAdminUserAction",
          summary: "Run a user action",
          description: "Supported actions: add-budget (returns full user state) and reset-usage (destructive: deletes all usage rows for the owner's keys).",
          security: adminSecurity,
          parameters: [{ name: "email", in: "path", required: true, schema: { type: "string", format: "email" } }],
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["action"],
              properties: {
                action: { type: "string", enum: ["add-budget", "reset-usage"] },
                amountUsd: {
                  type: "number",
                  exclusiveMinimum: 0,
                  description: "Required when action=add-budget. Must be strictly greater than zero.",
                },
              },
            },
            { action: "add-budget", amountUsd: 10 }
          ),
          responses: {
            200: jsonResponse(
              "Action result. add-budget returns { user }. reset-usage returns { user, reset }.",
              {
                type: "object",
                properties: {
                  user: ownerUserStateObject,
                  reset: { type: "object", additionalProperties: true },
                },
              }
            ),
            400: jsonResponse("Invalid action.", errorResponse),
            404: jsonResponse("User not found (only thrown by add-budget).", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
        delete: {
          tags: ["Admin"],
          operationId: "deleteAdminUser",
          summary: "Delete a sidebar user budget record",
          security: adminSecurity,
          parameters: [{ name: "email", in: "path", required: true, schema: { type: "string", format: "email" } }],
          responses: {
            200: jsonResponse(
              "Deleted user message.",
              {
                type: "object",
                properties: { message: { type: "string", example: "User budget removed" } },
              }
            ),
            400: jsonResponse("Invalid email in path.", errorResponse),
            404: jsonResponse("User not found.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/admin/api-keys": {
        get: {
          tags: ["Admin"],
          operationId: "listAdminApiKeys",
          summary: "List API keys",
          description: "Returns the raw key value (no masking). Treat the response as sensitive.",
          security: adminSecurity,
          responses: {
            200: jsonResponse(
              "API key list. Raw key values are not masked.",
              {
                type: "object",
                properties: {
                  keys: { type: "array", items: apiKeyObject },
                },
              }
            ),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
        post: {
          tags: ["Admin"],
          operationId: "createAdminApiKey",
          summary: "Create an API key",
          description: "Pass owner/userEmail to create a user-scoped routing key. Omit owner to create an unassigned routing key. Admin API access is separate and always uses ADMIN_API_KEY from .env.",
          security: adminSecurity,
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                owner: { type: "string", format: "email" },
                userEmail: { type: "string", format: "email" },
              },
            },
            { name: "External app key", owner: "user@example.com" }
          ),
          responses: {
            201: jsonResponse(
              "Created API key. Raw key is returned in the `key` field (and is also returned by every read endpoint — not just here).",
              {
                type: "object",
                properties: {
                  key: { type: "string", description: "Raw API key value." },
                  name: { type: "string" },
                  id: { type: "string" },
                  owner: { type: "string", format: "email", nullable: true },
                  userEmail: { type: "string", format: "email", nullable: true },
                  machineId: { type: "string", nullable: true },
                },
              }
            ),
            400: jsonResponse("Invalid API key payload.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/admin/api-keys/{id}": {
        get: {
          tags: ["Admin"],
          operationId: "getAdminApiKey",
          summary: "Get one API key",
          description: "Returns the raw key value (no masking).",
          security: adminSecurity,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: jsonResponse(
              "API key record. Raw key value is included.",
              {
                type: "object",
                properties: { key: apiKeyObject },
              }
            ),
            404: jsonResponse("API key not found.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
        patch: {
          tags: ["Admin"],
          operationId: "updateAdminApiKey",
          summary: "Update an API key",
          description: "Send only the fields you want to change. Pass owner/userEmail = \"\" to un-assign.",
          security: adminSecurity,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonRequest(
            {
              type: "object",
              properties: {
                name: { type: "string" },
                isActive: { type: "boolean" },
                owner: { oneOf: [{ type: "string", format: "email" }, { type: "string", enum: [""] }] },
                userEmail: { oneOf: [{ type: "string", format: "email" }, { type: "string", enum: [""] }] },
              },
            },
            { isActive: true, owner: "user@example.com" }
          ),
          responses: {
            200: jsonResponse(
              "Updated API key.",
              {
                type: "object",
                properties: { key: apiKeyObject },
              }
            ),
            400: jsonResponse("Invalid API key payload.", errorResponse),
            404: jsonResponse("API key not found.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
        delete: {
          tags: ["Admin"],
          operationId: "deleteAdminApiKey",
          summary: "Delete an API key",
          security: adminSecurity,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: jsonResponse(
              "Deleted API key message.",
              {
                type: "object",
                properties: { message: { type: "string", example: "Key deleted successfully" } },
              }
            ),
            404: jsonResponse("API key not found.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/admin/models": {
        get: {
          tags: ["Admin"],
          operationId: "getAdminModels",
          summary: "Get model sidebar data",
          security: adminSecurity,
          parameters: [
            {
              name: "view",
              in: "query",
              schema: { type: "string", enum: ["management", "public"], default: "management" },
            },
          ],
          responses: {
            200: jsonResponse("Model management catalog or public model list.", jsonObject),
            400: jsonResponse("Invalid view.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/admin/models/alias": {
        put: {
          tags: ["Admin"],
          operationId: "setAdminModelAlias",
          summary: "Set a model alias",
          description: "Re-setting an alias on the same model is a no-op (no error). Conflict (\"Alias already in use\") only fires when the alias is already mapped to a *different* model.",
          security: adminSecurity,
          requestBody: jsonRequest(
            {
              type: "object",
              required: ["model", "alias"],
              properties: {
                model: { type: "string", example: "openai/gpt-4o-mini" },
                alias: { type: "string", example: "fast-chat" },
              },
            },
            { model: "openai/gpt-4o-mini", alias: "fast-chat" }
          ),
          responses: {
            200: jsonResponse(
              "Alias update result.",
              {
                type: "object",
                properties: {
                  success: { type: "boolean", example: true },
                  model: { type: "string" },
                  alias: { type: "string" },
                },
              }
            ),
            400: jsonResponse("Invalid alias payload (missing fields or alias already in use).", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
      "/admin/pricing": {
        get: {
          tags: ["Admin"],
          operationId: "getAdminPricing",
          summary: "Get pricing configuration",
          description: "Pricing values are USD per 1 million tokens. The response is a nested map: { provider: { model: { field: number } } }.",
          security: adminSecurity,
          responses: {
            200: jsonResponse("Pricing configuration. Object keyed by provider, then by model.", jsonObject),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
        patch: {
          tags: ["Admin"],
          operationId: "updateAdminPricing",
          summary: "Update pricing configuration",
          description: "Merge update. Allowed fields per model: input, output, cached, reasoning, cache_creation. All values must be non-negative finite numbers (NaN is rejected).",
          security: adminSecurity,
          requestBody: jsonRequest(
            {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  properties: {
                    input: { type: "number", minimum: 0 },
                    output: { type: "number", minimum: 0 },
                    cached: { type: "number", minimum: 0 },
                    reasoning: { type: "number", minimum: 0 },
                    cache_creation: { type: "number", minimum: 0 },
                  },
                  additionalProperties: false,
                },
              },
            },
            {
              openai: {
                "gpt-4o-mini": { input: 0.15, output: 0.6, cached: 0.075 },
              },
            }
          ),
          responses: {
            200: jsonResponse("Updated pricing configuration (full shape, like GET).", jsonObject),
            400: jsonResponse("Invalid pricing payload.", errorResponse),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
        delete: {
          tags: ["Admin"],
          operationId: "resetAdminPricing",
          summary: "Reset pricing configuration",
          description: "Scope is determined by query params:\n- provider+model → reset one model\n- provider only → reset whole provider\n- neither → reset all\n- model without provider → ignored, falls back to full reset (no error).",
          security: adminSecurity,
          parameters: [
            { name: "provider", in: "query", schema: { type: "string" } },
            { name: "model", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: jsonResponse("Pricing configuration after reset.", jsonObject),
            ...authResponses,
            ...serverErrorResponse,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "9Router API key",
          description: "For regular /v1 routing endpoints, send a dashboard API key as: Authorization: Bearer <api-key>.",
        },
        apiKeyHeader: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "Compatibility header for Anthropic-style clients.",
        },
        adminBearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "ADMIN_API_KEY",
          description: "For /v1/admin/* endpoints, send ADMIN_API_KEY from .env as: Authorization: Bearer <ADMIN_API_KEY>.",
        },
        adminApiKeyHeader: {
          type: "apiKey",
          in: "header",
          name: "x-admin-api-key",
          description: "Alternative header for /v1/admin/* endpoints using ADMIN_API_KEY from .env.",
        },
      },
      schemas: {
        Error: errorResponse,
        Model: modelObject,
        Message: messageObject,
      },
    },
  };
}
