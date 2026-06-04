import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  addOwnerBudget: vi.fn(),
  deleteOwnerUser: vi.fn(),
  getOwnerBudgetState: vi.fn(),
  resetUsageForOwner: vi.fn(),
  upsertOwnerUser: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: mocks.jsonResponse,
  },
}));

vi.mock("@/lib/localDb", () => ({
  addOwnerBudget: mocks.addOwnerBudget,
  deleteOwnerUser: mocks.deleteOwnerUser,
  getOwnerBudgetState: mocks.getOwnerBudgetState,
  upsertOwnerUser: mocks.upsertOwnerUser,
}));

vi.mock("@/lib/usageDb", () => ({
  resetUsageForOwner: mocks.resetUsageForOwner,
}));

const userRoute = await import("../../src/app/api/users/[email]/route.js");

function request(body) {
  return { json: vi.fn().mockResolvedValue(body) };
}

function params(email = "USER@example.com") {
  return { params: Promise.resolve({ email }) };
}

describe("user route budget actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds to the existing user budget instead of replacing it", async () => {
    mocks.addOwnerBudget.mockResolvedValue({
      email: "user@example.com",
      budgetUsd: 20,
      spentUsd: 10,
      remainingUsd: 10,
    });

    const response = await userRoute.POST(request({
      action: "add-budget",
      amountUsd: 10,
    }), params());

    expect(response.status).toBe(200);
    expect(mocks.addOwnerBudget).toHaveBeenCalledWith("user@example.com", 10);
    expect(response.body.user.budgetUsd).toBe(20);
  });

  it("rejects non-positive budget additions", async () => {
    const response = await userRoute.POST(request({
      action: "add-budget",
      amountUsd: 0,
    }), params());

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Amount must be greater than zero");
    expect(mocks.addOwnerBudget).not.toHaveBeenCalled();
  });

  it("resets usage for the selected user", async () => {
    mocks.resetUsageForOwner.mockResolvedValue({ deleted: 3, apiKeyCount: 1 });
    mocks.getOwnerBudgetState.mockResolvedValue({
      email: "user@example.com",
      budgetUsd: 10,
      spentUsd: 0,
      remainingUsd: 10,
    });

    const response = await userRoute.POST(request({
      action: "reset-usage",
    }), params());

    expect(response.status).toBe(200);
    expect(mocks.resetUsageForOwner).toHaveBeenCalledWith("user@example.com");
    expect(response.body.reset.deleted).toBe(3);
    expect(response.body.user.spentUsd).toBe(0);
  });
});
