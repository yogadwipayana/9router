/**
 * Qoder model queue (code 10605 with isQueued / retryAfterSeconds).
 *
 * The queue means the model is full for the account's tier, not that the account is
 * broken: the executor waits retryAfterSeconds and retries once with a fresh signature,
 * then hands chatCore a 429 + Retry-After so the model is locked only that long.
 *
 * Both sides of the v0.5.109 merge created this file independently, for two
 * different layers; the union of their cases is kept here.
 *
 *   1. The executor-level queue retry (fork): parseQoderQueue, qoderQueueRetries,
 *      wrapQoderSSE's 429 + Retry-After, QoderExecutor.parseError's short model
 *      lock and the wait/retry loop in QoderExecutor.execute.
 *   2. The pure helpers in shared/qoder/queue.js (upstream v0.5.109):
 *      parseQoderQueueInfo, isQoderQueuedBody, computeQoderQueueDelayMs,
 *      qoderQueueStatusUrl, parseQoderQueueStatus and qoderQueueMaxWaitMs. Those
 *      payloads are the real ones Qoder returns (2026-10-19) for a queued model: a
 *      `{statusCodeValue, body}` SSE envelope whose body nests the queue object
 *      inside two more JSON strings. They are matched on content, never on exact
 *      byte shape, because the nesting depth varies by endpoint.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QODER_QUEUE_CODE,
  computeQoderQueueDelayMs,
  isQoderQueuedBody,
  parseQoderQueueInfo,
  parseQoderQueueStatus,
  qoderQueueMaxWaitMs,
  qoderQueueStatusUrl,
} from "../../open-sse/shared/qoder/queue.js";
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

  it("does not take the retry path for a bare 10605 without a retry hint", async () => {
    const { internals } = await loadExecutor(vi.fn());
    const bare = '{"code":"10605","message":"Queue limit"}';
    // No isQueued / retryAfterSeconds hint, so there is nothing to wait for and
    // execute() must not enter the queue retry loop for this frame.
    expect(internals.parseQoderQueue(bare)).toBeNull();
    // MERGE NOTE (v0.5.109): this used to assert isBillingBlock(bare) === true.
    // Upstream removed 10605 from isBillingBlock (it is the transient model-queue
    // throttle, never a billing block) in a NON-conflicting hunk, so that change
    // auto-merged, and qoder-billing.test.js now pins isBillingBlock(bare) ===
    // false. The runtime outcome is unchanged either way: wrapQoderSSE keeps the
    // envelope's own 4xx for this frame, it just no longer rewrites it to 403
    // through the billing branch. The queue-side half of this case is the part
    // that pins executor behaviour, so it is kept as-is.
    expect(internals.isBillingBlock(bare)).toBe(false);
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

// ---------------------------------------------------------------------------
// shared/qoder/queue.js helpers (upstream v0.5.109). Pure parsers with no
// executor involvement, so they stand alongside the executor-level cases
// above rather than replacing them.
// ---------------------------------------------------------------------------
const QUEUE_OBJECT = {
  isQueued: true,
  modelKey: "auto",
  queueCount: 0,
  queueType: "p3",
  retryAfterSeconds: 30,
  serviceAvailable: false,
  subCode: "RESOURCE_LIMIT",
  waitTime: 30,
};

/** Encode the queue object the way upstream does: inside nested JSON strings. */
function nestQueue(depth = 2) {
  let payload = JSON.stringify(QUEUE_OBJECT);
  for (let i = 0; i < depth; i++) {
    payload = JSON.stringify({ code: i === 0 ? QODER_QUEUE_CODE : "403", message: payload, subCode: "RESOURCE_LIMIT" });
  }
  return payload;
}

describe("parseQoderQueueInfo", () => {
  it("parses a doubly-nested queue payload", () => {
    const info = parseQoderQueueInfo(nestQueue(2));
    expect(info).not.toBeNull();
    expect(info.isQueued).toBe(true);
    expect(info.modelKey).toBe("auto");
    expect(info.queueType).toBe("p3");
    expect(info.retryAfterSeconds).toBe(30);
    expect(info.serviceAvailable).toBe(false);
    expect(info.subCode).toBe("RESOURCE_LIMIT");
  });

  it("parses a triply-nested queue payload", () => {
    const info = parseQoderQueueInfo(nestQueue(3));
    expect(info?.isQueued).toBe(true);
    expect(info?.modelKey).toBe("auto");
  });

  it("parses the envelope shape wrapQoderSSE sees", () => {
    const envelope = JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body: nestQueue(2),
      statusCodeValue: 403,
      statusCode: "FORBIDDEN",
    });
    expect(parseQoderQueueInfo(envelope)?.isQueued).toBe(true);
  });

  it("accepts an already-parsed object", () => {
    expect(parseQoderQueueInfo({ error: { message: nestQueue(1) } })?.queueType).toBe("p3");
  });

  it("returns null for a billing block (code 112)", () => {
    expect(parseQoderQueueInfo('{"code":"112","message":"Quota exhausted","pricingUrl":"x"}')).toBeNull();
  });

  it("returns null for an ordinary error", () => {
    expect(parseQoderQueueInfo('{"code":"500","message":"Internal error"}')).toBeNull();
  });

  it("returns null for empty and non-JSON input", () => {
    expect(parseQoderQueueInfo("")).toBeNull();
    expect(parseQoderQueueInfo("not json")).toBeNull();
    expect(parseQoderQueueInfo(null)).toBeNull();
    expect(parseQoderQueueInfo(undefined)).toBeNull();
  });

  it("still flags a bare 10605 code without the inner object", () => {
    // The code alone is the signal; upstream has been seen to omit the detail.
    expect(parseQoderQueueInfo('{"code":"10605"}')?.code).toBe("10605");
  });
});

describe("isQoderQueuedBody", () => {
  it("is true for a queued payload", () => {
    expect(isQoderQueuedBody(nestQueue(2))).toBe(true);
  });

  it("is false for a billing block", () => {
    expect(isQoderQueuedBody('{"code":"112","message":"Quota exhausted"}')).toBe(false);
  });

  it("is false for a normal completion chunk", () => {
    const chunk = JSON.stringify({ choices: [{ delta: { content: "hi" } }], statusCodeValue: 200 });
    expect(isQoderQueuedBody(chunk)).toBe(false);
  });
});

describe("computeQoderQueueDelayMs", () => {
  it("honours retryAfterSeconds from the inference refusal", () => {
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 30 })).toBe(30_000);
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 20 })).toBe(20_000);
  });

  it("falls back to waitTime when retryAfterSeconds is absent", () => {
    expect(computeQoderQueueDelayMs({ waitTime: 25 })).toBe(25_000);
  });

  it("never replays faster than 15s, even on a tiny hint", () => {
    // Qoder answers retryAfterSeconds:2 while still refusing; replaying that
    // fast makes the throttle worse.
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 0 })).toBe(15_000);
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 2 })).toBe(15_000);
  });

  it("clamps the upper bound to 60s", () => {
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 600 })).toBe(60_000);
  });

  it("uses a 30s default when no hint is present", () => {
    expect(computeQoderQueueDelayMs(null)).toBe(30_000);
    expect(computeQoderQueueDelayMs({})).toBe(30_000);
  });

  it("raises a status-derived hint to 30s", () => {
    // The queue-status endpoint has reported isQueued:false with
    // retryAfterSeconds:2 while the inference call was still refused, so its
    // hint is not trusted below one full interval.
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 2 }, { fromStatus: true })).toBe(30_000);
    expect(computeQoderQueueDelayMs({ retryAfterSeconds: 45 }, { fromStatus: true })).toBe(45_000);
  });
});

describe("qoderQueueStatusUrl", () => {
  it("carries both required parameters", () => {
    const url = qoderQueueStatusUrl("https://api2.qoder.sh", { requestSetId: "abc-123", modelKey: "auto" });
    expect(url).toBe(
      "https://api2.qoder.sh/algo/api/v2/service/ask/queue/status?requestSetId=abc-123&modelKey=auto",
    );
  });

  it("adds queueType when known", () => {
    const url = qoderQueueStatusUrl("https://api2.qoder.sh", {
      requestSetId: "abc",
      modelKey: "auto",
      queueType: "p3",
    });
    expect(url).toContain("queueType=p3");
  });

  it("omits parameters it was not given", () => {
    expect(qoderQueueStatusUrl("https://api2.qoder.sh", {})).toBe(
      "https://api2.qoder.sh/algo/api/v2/service/ask/queue/status?",
    );
  });
});

describe("parseQoderQueueStatus", () => {
  it("parses the ready shape", () => {
    const info = parseQoderQueueStatus(
      '{"isQueued":false,"modelKey":"auto","queueType":"p3","queueCount":0,"waitTime":0,"retryAfterSeconds":2,"serviceAvailable":true}',
    );
    expect(info).toEqual({
      isQueued: false,
      serviceAvailable: true,
      modelKey: "auto",
      queueType: "p3",
      queueCount: 0,
      retryAfterSeconds: 2,
      waitTime: 0,
    });
  });

  it("parses the still-queued shape", () => {
    const info = parseQoderQueueStatus(
      '{"subCode":"RESOURCE_LIMIT","isQueued":true,"modelKey":"auto","queueType":"p3","queueCount":0,"waitTime":30,"retryAfterSeconds":30,"serviceAvailable":false}',
    );
    expect(info?.isQueued).toBe(true);
    expect(info?.waitTime).toBe(30);
  });

  it("returns null when isQueued is missing (unknown endpoint shape)", () => {
    expect(parseQoderQueueStatus('{"status":"ok"}')).toBeNull();
    expect(parseQoderQueueStatus("")).toBeNull();
    expect(parseQoderQueueStatus("not json")).toBeNull();
  });
});

describe("qoderQueueMaxWaitMs", () => {
  it("defaults to 10 minutes", () => {
    const prev = process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
    delete process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
    expect(qoderQueueMaxWaitMs()).toBe(600_000);
    if (prev !== undefined) process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS = prev;
  });

  it("honours the env override", () => {
    const prev = process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
    process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS = "5000";
    expect(qoderQueueMaxWaitMs()).toBe(5000);
    if (prev === undefined) delete process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
    else process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS = prev;
  });

  it("ignores a nonsensical override", () => {
    const prev = process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
    process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS = "not-a-number";
    expect(qoderQueueMaxWaitMs()).toBe(600_000);
    if (prev === undefined) delete process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
    else process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS = prev;
  });
});
