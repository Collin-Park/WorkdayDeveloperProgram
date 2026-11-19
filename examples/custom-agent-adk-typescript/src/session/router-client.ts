// This turn's credentials for the Router. Valid for one turn only.
export interface RouterCredentials {
  acRouterToken: string;
  wdTenant: string;
  // Base Router URL (see resolveRouterUrl), trailing slashes removed.
  routerUrl: string;
}

export const SESSIONS_PATH = "/sandbox/v1/sessions";

export interface RouterResponse {
  status: number;
  json: unknown;
}

// One HTTP call to the Router. Throws on a network error or a timeout; any
// HTTP status is returned to the caller. The response body is never put in
// an error, so Router error text does not reach the agent's logs.
export async function callRouter(
  fetchImpl: typeof fetch,
  credentials: RouterCredentials,
  timeoutMs: number,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<RouterResponse> {
  const headers: Record<string, string> = {
    "x-acr-token": credentials.acRouterToken,
    "wd-tenant": credentials.wdTenant,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetchImpl(credentials.routerUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

// 408, 429 and 5xx can succeed later. Other 4xx statuses will fail again
// with the same request.
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
