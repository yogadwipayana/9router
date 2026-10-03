/**
 * Qoder capacity queue (code 10605 with isQueued / retryAfterSeconds).
 *
 * The queue means the model is full for the account's tier, not that the account is
 * broken: the executor waits retryAfterSeconds and retries once with a fresh signature,
 * then hands chatCore a 429 + Retry-After so the model is locked only that long.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(async () => ({ key: "qmodel_38max", max_output_tokens: 32 })),
  resolveQoderModels: vi.fn(),
  isQoderPat: () => false,
  resolveQoderCredentials: vi.fn(),
}));

const request = {
  model: "qmodel_38max",
  body: { messages: [{ role: "user", content: "hi" }], max_tokens: 32 },
  stream: true,
  credentials: {
    accessToken: "dt-test-token",
    providerSpecificData: { userId: "test-user", machineId: "test-machine" },
  },
};

// Exactly the nesting Qoder sent on 2026-10-03 (403 → 10605 → queue details).
function queueInner({ retryAfterSeconds = 30, modelKey = "qmodel_38max" } = {}) {
  return JSON.stringify({
    code: "403",
    message: JSON.stringify({
      code: "10605",
      message: JSON.stringify({
        isQueued: true,
        modelKey,
        queueCount: 0,
        queueType: "p3",
        retryAfterSeconds,
        serviceAvailable: false,
        waitTime: retryAfterSeconds,
      }),
    }),
  });
}

function sse(lines) {
  return new Response(lines.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function queued(opts) {
  return sse([`data: ${JSON.stringify({ statusCodeValue: 403, body: queueInner(opts) })}\n\n`]);
}

function success() {
  return sse(['data: {"statusCodeValue":200,"body":"[DONE]"}\n\n']);
}

async function loadExecutor(fetchMock) {
  vi.resetModules();
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    vi.stubEnv(key, "");
  }
  vi.stubGlobal("fetch", fetchMock);
  const mod = await import("../../open-sse/executors/qoder.js");
  return { executor: new mod.QoderExecutor(), internals: mod.__test__ };
}

function cosyRequestId(call) {
  const [, options] = call;
  return JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64").toString()).requestId;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseQoderQueue", () => {
  it("unwraps the nested 403 → 10605 → isQueued payload", async () => {
    const { internals } = await loadExecutor(vi.fn());
    expect(internals.parseQoderQueue(queueInner())).toEqual({
      retryAfterSeconds: 30,
      queueType: "p3",
      modelKey: "qmodel_38max",
    });
  });

  it("leaves a bare 10605 without a retry hint on the billing path", async () => {
    const { internals } = await loadExecutor(vi.fn());
    const bare = '{"code":"10605","message":"Queue limit"}';
    expect(internals.parseQoderQueue(bare)).toBeNull();
    expect(internals.isBillingBlock(bare)).toBe(true);
  });

  it("ignores billing blocks and non-JSON bodies", async () => {
    const { internals } = await loadExecutor(vi.fn());
    expect(internals.parseQoderQueue('{"code":"112","message":"Quota exhausted","pricingUrl":"x"}')).toBeNull();
    expect(internals.parseQoderQueue("upstream exploded")).toBeNull();
    expect(internals.parseQoderQueue("")).toBeNull();
  });

  it("reads QODER_QUEUE_RETRIES with a default of 1 and a cap of 3", async () => {
    const { internals } = await loadExecutor(vi.fn());
    expect(internals.qoderQueueRetries({})).toBe(1);
    expect(internals.qoderQueueRetries({ QODER_QUEUE_RETRIES: "0" })).toBe(0);
    expect(internals.qoderQueueRetries({ QODER_QUEUE_RETRIES: "2" })).toBe(2);
    expect(internals.qoderQueueRetries({ QODER_QUEUE_RETRIES: "99" })).toBe(3);
    expect(internals.qoderQueueRetries({ QODER_QUEUE_RETRIES: "nope" })).toBe(1);
  });
});

describe("wrapQoderSSE + parseError for a queued first frame", () => {
  it("returns 429 with Retry-After instead of the generic 403", async () => {
    const { internals } = await loadExecutor(vi.fn());
    const wrapped = await internals.wrapQoderSSE(queued(), "qoder/qmodel_38max");
    expect(wrapped.status).toBe(429);
    expect(wrapped.headers.get("Retry-After")).toBe("30");
    const json = await wrapped.json();
    expect(json.error.code).toBe("10605");
    expect(json.error.message).toContain("qmodel_38max");
    expect(json.error.message).toContain("queue p3");
  });

  it("locks the model only for Retry-After", async () => {
    const { executor, internals } = await loadExecutor(vi.fn());
    const wrapped = await internals.wrapQoderSSE(queued(), "qoder/qmodel_38max");
    const bodyText = await wrapped.text();
    const before = Date.now();
    const parsed = executor.parseError(wrapped, bodyText);
    expect(parsed.status).toBe(429);
    expect(parsed.resetsAtMs).toBeGreaterThanOrEqual(before + 30_000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(parsed.message).toContain("retry after 30s");
  });

  it("keeps the default parse for every other error", async () => {
    const { executor } = await loadExecutor(vi.fn());
    const res = new Response("boom", { status: 403 });
    expect(executor.parseError(res, "boom")).toEqual({ status: 403, message: "boom" });
  });
});

describe("QoderExecutor.execute on a queued model", () => {
  it("waits, retries once with a fresh signature and succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(queued({ retryAfterSeconds: 1 }))
      .mockResolvedValueOnce(success());
    const { executor } = await loadExecutor(fetchMock);
    const result = await executor.execute(request);
    expect(result.response.ok).toBe(true);
    await result.response.text();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cosyRequestId(fetchMock.mock.calls[0])).not.toBe(cosyRequestId(fetchMock.mock.calls[1]));
  });

  it("gives up after the retry and lets the next account fail fast", async () => {
    const fetchMock = vi.fn(async () => queued({ retryAfterSeconds: 1 }));
    const { executor } = await loadExecutor(fetchMock);

    const first = await executor.execute(request);
    expect(first.response.status).toBe(429);
    expect(first.response.headers.get("Retry-After")).toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Next account, same model, still inside the queue window: no second wait.
    const second = await executor.execute({
      ...request,
      credentials: { accessToken: "dt-other", providerSpecificData: { userId: "other-user" } },
    });
    expect(second.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not wait when QODER_QUEUE_RETRIES=0", async () => {
    vi.stubEnv("QODER_QUEUE_RETRIES", "0");
    const fetchMock = vi.fn(async () => queued());
    const { executor } = await loadExecutor(fetchMock);
    const result = await executor.execute(request);
    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps the wait at 30s even when Qoder asks for longer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(queued({ retryAfterSeconds: 120 }))
      .mockResolvedValueOnce(success());
    const { executor } = await loadExecutor(fetchMock);
    const pending = executor.execute(request);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.response.ok).toBe(true);
    await result.response.text();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops waiting when the client disconnects", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      setTimeout(() => controller.abort(), 20);
      return queued({ retryAfterSeconds: 30 });
    });
    const { executor } = await loadExecutor(fetchMock);
    await expect(executor.execute({ ...request, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
