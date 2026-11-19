import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { toA2a } from "@google/adk";
import type { User } from "@a2a-js/sdk/server";
import express from "express";
import { rootAgent } from "./agent.js";
import { setTurnCredentials } from "./turn-credentials.js";
import { requireRouterCredentials } from "./router-credentials.js";
import { logError, logInfo, logWarn, redactSecret, truncate } from "./logger.js";
import { RouterSessionService } from "./session/router-session-service.js";

// The A2A server. Workday tools come through the Router's /sandbox/v1/mcp
// (see router-mcp.ts). The ADK session is stored through the Router's
// /sandbox/v1/sessions (see session/), so a conversation continues on a new
// MicroVM.

const port = Number(process.env.PORT ?? 8080);

const TOKEN_HEADER = "x-acr-token";
const WD_TENANT_HEADER = "wd-tenant";

// Never log these headers' raw values -- see redactHeaders below.
const SENSITIVE_HEADERS = new Set(["x-acr-token", "authorization", "cookie"]);

class RouterCredentialedUser implements User {
  readonly isAuthenticated = true;
  constructor(readonly userName: string) {}
}

function redactHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const raw = Array.isArray(value) ? value.join(", ") : value;
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? redactSecret(raw) : raw;
  }
  return result;
}

// Monkey-patches `res.write`/`res.end` to buffer every chunk written to the
// response, so the full response body (JSON-RPC result or concatenated SSE
// stream) can be logged once the response finishes -- Express/A2A give no
// other hook to observe outgoing bytes.
function captureResponseBody(res: express.Response): () => string {
  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = ((chunk: unknown, ...args: unknown[]) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  }) as typeof res.write;

  res.end = ((chunk?: unknown, ...args: unknown[]) => {
    if (chunk && typeof chunk !== "function") {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return (originalEnd as (...a: unknown[]) => express.Response)(chunk, ...args);
  }) as typeof res.end;

  return () => Buffer.concat(chunks).toString("utf8");
}

// The MicroVM is reached only through the platform's authenticated proxy,
// not a raw routable port, so the caller is the Router. This callback does
// not authenticate the caller.
//
// What it does: take this turn's `X-ACR-Token`/`wd-tenant` off the inbound A2A
// request and make them available to the outbound Router calls, since ADK's
// model call has no other path back to these headers (see
// turn-credentials.ts). `UserBuilder` is the earliest point
// `toA2a()`/`@a2a-js/sdk` calls per request, before the agent is invoked.
//
// Always captures whatever's present rather than gating on both being set
// together: each field is independently defaulted/enforced at its own read
// site (acRouterToken/wdTenant fall back to env vars if absent here) -- this
// callback's job is only to capture, not to enforce presence.
//
// The Router address is deliberately not read from the request: any
// `X-Workday-URL` header is ignored (see resolveRouterUrl).
const captureTurnCredentials = async (req: { header(name: string): string | undefined }): Promise<User> => {
  const acRouterToken = req.header(TOKEN_HEADER);
  const wdTenant = req.header(WD_TENANT_HEADER);
  setTurnCredentials({ acRouterToken, wdTenant });
  logInfo("auth", "captured turn credentials from inbound A2A request", {
    wdTenant: wdTenant ?? "<absent>",
    acRouterToken: redactSecret(acRouterToken),
  });
  return new RouterCredentialedUser(wdTenant ?? "unauthenticated");
};

// Own the express app (rather than letting `toA2a()` create one) so
// request/response logging middleware can run first -- ahead of body
// parsing and the A2A route handlers it registers internally.
const app = express();

app.use((req, res, next) => {
  const requestId = randomUUID();
  const startedAt = Date.now();

  logInfo("http", `--> ${req.method} ${req.originalUrl}`, {
    requestId,
    headers: redactHeaders(req.headers),
  });

  const getResponseBody = captureResponseBody(res);
  res.on("finish", () => {
    logInfo("http", `<-- ${req.method} ${req.originalUrl} ${res.statusCode}`, {
      requestId,
      durationMs: Date.now() - startedAt,
      body: truncate(getResponseBody()),
    });
  });

  next();
});

app.use(
  express.json({
    limit: "50mb",
    // Captures the exact bytes received, before JSON parsing, so the request
    // payload can be logged verbatim even if parsing later fails.
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }),
);

app.use((req, _res, next) => {
  const rawBody = (req as express.Request & { rawBody?: string }).rawBody;
  if (rawBody) {
    logInfo("http", `request payload: ${req.method} ${req.originalUrl}`, { body: truncate(rawBody) });
  }
  next();
});

const sessionService = new RouterSessionService({
  // Missing credentials are not an error here: the session service logs
  // them and keeps the turn going.
  credentials: () => {
    try {
      return requireRouterCredentials();
    } catch {
      return undefined;
    }
  },
  logger: ({ level, message, ...data }) => {
    const log = level === "error" ? logError : level === "warn" ? logWarn : logInfo;
    log("session", message, data);
  },
});

const a2aApp = await toA2a(rootAgent, {
  host: process.env.A2A_HOST ?? "0.0.0.0",
  port,
  authentication: captureTurnCredentials,
  sessionService,
  app,
});

// Not part of the A2A surface -- a plain liveness check.
a2aApp.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

a2aApp.listen(port, () => {
  logInfo("startup", `custom-agent-adk-typescript listening on port ${port} (A2A + /health)`);
});
