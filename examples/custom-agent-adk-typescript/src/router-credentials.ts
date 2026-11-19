import { getTurnCredentials } from "./turn-credentials.js";

// Every agent calls the Router at this name. It resolves only inside the
// platform's network, where agents run. Its certificate is a public one, so
// nothing has to be added to the image's trust store.
export const DEFAULT_ROUTER_URL = "https://agent-harness.workday.com";

// This turn's credentials for any outbound call to the Router: inference
// (`AcRouterLlm`) and MCP tools (`router-mcp.ts`) resolve them the same way,
// with the same errors. See ac-router-llm.ts's class comment for the order
// (turn headers first, then the env vars for local testing, for the token and
// tenant). The Router URL is not per turn: see `resolveRouterUrl`.
export interface RouterCredentials {
  acRouterToken: string;
  wdTenant: string;
  // Base Router host, trailing slashes removed.
  routerUrl: string;
}

// Where to call the Router: `AC_ROUTER_URL`, defaulting to the public name above.
//
// Deliberately not taken from the inbound request. This agent sends its AC
// Router token to this address, so a caller-supplied header must not be able to
// choose it. The `X-Workday-URL` header that used to carry it is ignored.
//
// https only, except a loopback address so a local fake Router can be used.
export function resolveRouterUrl(): string {
  const configured = process.env.AC_ROUTER_URL?.trim();
  const value = configured ? configured : DEFAULT_ROUTER_URL;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AC_ROUTER_URL is not a valid URL: ${value}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`AC_ROUTER_URL must be https (http is allowed only for localhost): ${value}`);
  }
  return value.replace(/\/+$/, "");
}

export function requireRouterCredentials(): RouterCredentials {
  const turnCredentials = getTurnCredentials();
  const acRouterToken = turnCredentials?.acRouterToken ?? process.env.AC_ROUTER_TOKEN;
  if (!acRouterToken) {
    throw new Error(
      "AC_ROUTER_TOKEN is not available -- this turn's invoke call must carry it " +
        "as the X-ACR-Token header, or the environment must set AC_ROUTER_TOKEN " +
        "(for local testing).",
    );
  }
  const wdTenant = turnCredentials?.wdTenant ?? process.env.WD_TENANT;
  if (!wdTenant) {
    throw new Error(
      "wd-tenant is not available -- the Router is multi-tenant and requires the " +
        "caller's tenant on every request, either as this turn's wd-tenant header " +
        "or the WD_TENANT environment variable (for local testing).",
    );
  }
  return { acRouterToken, wdTenant, routerUrl: resolveRouterUrl() };
}
