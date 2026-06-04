import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeyAccessState: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeyAccessState: mocks.getApiKeyAccessState,
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

const { getApiKeyValidationError } = await import("../../src/sse/services/auth.js");

describe("API key validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing API keys", async () => {
    const error = await getApiKeyValidationError(null);

    expect(error).toMatchObject({
      status: 401,
      reason: "missing",
      message: "Missing API key",
    });
    expect(mocks.getApiKeyAccessState).not.toHaveBeenCalled();
  });

  it("rejects missing API keys when keys are required", async () => {
    const error = await getApiKeyValidationError(null);

    expect(error).toMatchObject({
      status: 401,
      reason: "missing",
      message: "Missing API key",
    });
    expect(mocks.getApiKeyAccessState).not.toHaveBeenCalled();
  });

  it("rejects over-budget provided API keys", async () => {
    mocks.getApiKeyAccessState.mockResolvedValue({
      valid: false,
      reason: "owner_budget_exhausted",
      owner: { email: "user@example.com", budgetUsd: 20 },
    });

    const error = await getApiKeyValidationError("sk-over-budget");

    expect(mocks.getApiKeyAccessState).toHaveBeenCalledWith("sk-over-budget");
    expect(error).toMatchObject({
      status: 403,
      reason: "owner_budget_exhausted",
      message: "user@example.com has reached the $20.00 budget limit",
    });
  });

  it("allows valid provided API keys", async () => {
    mocks.getApiKeyAccessState.mockResolvedValue({ valid: true });

    const error = await getApiKeyValidationError("sk-valid");

    expect(error).toBeNull();
  });
});
