import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  getApiKeyById: vi.fn(),
  getOwnerUserByEmail: vi.fn(),
  updateApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: mocks.jsonResponse,
  },
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: mocks.getApiKeys,
  createApiKey: mocks.createApiKey,
  getApiKeyById: mocks.getApiKeyById,
  getOwnerUserByEmail: mocks.getOwnerUserByEmail,
  updateApiKey: mocks.updateApiKey,
  deleteApiKey: mocks.deleteApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

const keysRoute = await import("../../src/app/api/keys/route.js");
const keyRoute = await import("../../src/app/api/keys/[id]/route.js");

function request(body) {
  return { json: vi.fn().mockResolvedValue(body) };
}

describe("API key routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConsistentMachineId.mockResolvedValue("machine-abc");
    mocks.getApiKeyById.mockResolvedValue({ id: "key-1", name: "Existing", owner: "user@example.com" });
  });

  it("rejects create when the selected user email does not exist", async () => {
    mocks.getOwnerUserByEmail.mockResolvedValue(null);

    const response = await keysRoute.POST(request({
      name: "Prod",
      userEmail: "missing@example.com",
    }));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Create this user before assigning API keys");
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("creates a key only for an existing user email", async () => {
    mocks.getOwnerUserByEmail.mockResolvedValue({ email: "user@example.com", configured: true });
    mocks.createApiKey.mockResolvedValue({
      id: "key-1",
      key: "sk-test",
      name: "Prod",
      owner: "user@example.com",
      userEmail: "user@example.com",
      machineId: "machine-abc",
    });

    const response = await keysRoute.POST(request({
      name: "Prod",
      userEmail: "USER@example.com",
    }));

    expect(response.status).toBe(201);
    expect(mocks.createApiKey).toHaveBeenCalledWith("Prod", "machine-abc", "user@example.com");
    expect(response.body.userEmail).toBe("user@example.com");
  });

  it("rejects changing a key to a user email that does not exist", async () => {
    mocks.getOwnerUserByEmail.mockResolvedValue(null);

    const response = await keyRoute.PUT(request({
      userEmail: "missing@example.com",
    }), { params: Promise.resolve({ id: "key-1" }) });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Create this user before assigning API keys");
    expect(mocks.updateApiKey).not.toHaveBeenCalled();
  });

  it("updates key user email when the user exists", async () => {
    mocks.getOwnerUserByEmail.mockResolvedValue({ email: "user@example.com", configured: true });
    mocks.updateApiKey.mockResolvedValue({
      id: "key-1",
      name: "Existing",
      owner: "user@example.com",
      userEmail: "user@example.com",
    });

    const response = await keyRoute.PUT(request({
      userEmail: "USER@example.com",
    }), { params: Promise.resolve({ id: "key-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.updateApiKey).toHaveBeenCalledWith("key-1", { owner: "user@example.com" });
    expect(response.body.key.userEmail).toBe("user@example.com");
  });
});
