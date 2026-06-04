import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
    headers: init?.headers || {},
  })),
  getSettings: vi.fn(),
  cookies: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  isOidcConfigured: vi.fn(),
  checkLock: vi.fn(),
  recordFail: vi.fn(),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(),
  bcryptCompare: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: mocks.jsonResponse,
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
}));

vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: mocks.isOidcConfigured,
}));

vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: mocks.checkLock,
  recordFail: mocks.recordFail,
  recordSuccess: mocks.recordSuccess,
  getClientIp: mocks.getClientIp,
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: mocks.bcryptCompare,
  },
}));

const { POST } = await import("../../src/app/api/auth/login/route.js");

const originalInitialEmail = process.env.INITIAL_EMAIL;
const originalInitialPassword = process.env.INITIAL_PASSWORD;

function loginRequest(body) {
  return {
    headers: new Headers({ host: "localhost:20128" }),
    json: vi.fn().mockResolvedValue(body),
  };
}

describe("dashboard login route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INITIAL_EMAIL = "yoga@gmail.com";
    process.env.INITIAL_PASSWORD = "Fortuna1505";
    mocks.getClientIp.mockReturnValue("127.0.0.1");
    mocks.checkLock.mockReturnValue({ locked: false });
    mocks.recordFail.mockReturnValue({ remainingBeforeLock: 4 });
    mocks.cookies.mockResolvedValue({ set: vi.fn() });
    mocks.getSettings.mockResolvedValue({
      password: "",
      authMode: "password",
      tunnelDashboardAccess: true,
    });
    mocks.isOidcConfigured.mockReturnValue(false);
  });

  afterEach(() => {
    process.env.INITIAL_EMAIL = originalInitialEmail;
    process.env.INITIAL_PASSWORD = originalInitialPassword;
  });

  it("accepts initial email and password from env", async () => {
    const response = await POST(loginRequest({
      email: "yoga@gmail.com",
      password: "Fortuna1505",
    }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mocks.recordSuccess).toHaveBeenCalledWith("127.0.0.1");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalled();
  });

  it("normalizes email before checking env email", async () => {
    const response = await POST(loginRequest({
      email: "  YOGA@GMAIL.COM  ",
      password: "Fortuna1505",
    }));

    expect(response.status).toBe(200);
  });

  it("rejects an invalid email even when password matches", async () => {
    const response = await POST(loginRequest({
      email: "other@example.com",
      password: "Fortuna1505",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toContain("Invalid email or password");
    expect(mocks.recordFail).toHaveBeenCalledWith("127.0.0.1");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("requires both email and password", async () => {
    const response = await POST(loginRequest({ password: "Fortuna1505" }));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Email and password are required");
  });

  it("uses stored password hash after the email matches", async () => {
    mocks.getSettings.mockResolvedValue({
      password: "stored-hash",
      authMode: "password",
      tunnelDashboardAccess: true,
    });
    mocks.bcryptCompare.mockResolvedValue(true);

    const response = await POST(loginRequest({
      email: "yoga@gmail.com",
      password: "custom-password",
    }));

    expect(response.status).toBe(200);
    expect(mocks.bcryptCompare).toHaveBeenCalledWith("custom-password", "stored-hash");
  });
});
