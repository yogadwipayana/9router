import { proxy as dashboardProxy } from "./dashboardGuard";

export function proxy(request) {
  return dashboardProxy(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
