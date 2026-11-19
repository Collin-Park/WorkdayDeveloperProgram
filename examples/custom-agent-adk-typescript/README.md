# Custom Agent template (ADK TypeScript)

## What it is

A complete Custom Agent built with the Google [Agent Development Kit](https://adk.dev) for TypeScript (`@google/adk` 2.5) and served over the [A2A protocol](https://a2a-protocol.org). Copy it to start your own agent. You need access to the Workday custom-agent Early Access program to deploy it.

The agent runs in a MicroVM. It reaches Workday only through the Router: model inference, Workday tools (MCP), and session storage all go to the Router with the credentials of the current turn. The instruction in `src/agent.ts` is a generic Workday assistant. The expenses sample is in `wd_agent_card.json`: one expenses skill and its tools. Change the instruction and the card to build your own agent.

In the code and environment variables, `AC Router` and `AC_ROUTER_*` mean the Router.

## What's inside

- `src/index.ts`: the A2A server. Captures each turn's credentials and passes `RouterSessionService` to `toA2a`.
- `src/agent.ts`: the `LlmAgent`, with its instruction and the Router MCP tools.
- `src/ac-router-llm.ts`: `AcRouterLlm`, a `BaseLlm` that calls the Router's OpenAI-compatible `/sandbox/v1/chat/completions`.
- `src/router-mcp.ts`: the Workday tools, an `MCPToolset` over the Router's `/sandbox/v1/mcp`.
- `src/turn-credentials.ts`: keeps this turn's `X-ACR-Token` and `wd-tenant` in `AsyncLocalStorage`.
- `src/router-credentials.ts`: the Router URL and the credentials for every outbound call.
- `src/session/`: `RouterSessionService` (sessions stored through the Router's `/sandbox/v1/sessions`) and the `/dev/urandom` ID provider.
- `src/logger.ts`: verbose console logging. Only the token and the `authorization`/`cookie` headers are redacted; request and response bodies are logged truncated (see "Before you deploy").
- `src/**/*.test.ts`: unit tests (Node's built-in test runner). They make no network calls.
- `wd_agent_card.json`: the agent card you register.
- `appspec.yaml`: build and start commands for the platform.
- `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.wdignore`: the Node project.

## How to use it

Node 22 is required. From this folder:

```bash
npm ci
npm run build
npm test
npm run dev      # runs src/index.ts with tsx on port 8080
```

### Store sessions through the Router

A conversation can move to a new MicroVM between turns, so the session cannot live only in memory. `RouterSessionService` keeps the session in memory and writes every event through to the Router; a new MicroVM loads the session from the Router. Create it and pass it to `toA2a` (`src/index.ts`):

```ts
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
```

If you build your own ADK `Runner` instead of using `toA2a`, pass the same `sessionService` to it.

### Install the /dev/urandom ID provider

An agent runs in a MicroVM started from a snapshot, so every new MicroVM starts with the same `Math.random` state. ADK's default event IDs come from `Math.random`. Without another ID provider, a new MicroVM repeats event IDs, and the Router, which stores events by ID, overwrites earlier session history. Node's `crypto` does not fix this, because its generator state is also in the snapshot. `/dev/urandom` is reseeded by the kernel when the MicroVM starts.

`src/session/urandom-uuid.ts` installs the provider with `setIdProvider`:

```ts
export function installUrandomIdProvider(uuid: () => string = urandomUuid): boolean {
  try {
    uuid();
  } catch {
    return false;
  }
  setIdProvider(uuid);
  return true;
}
```

The `RouterSessionService` constructor calls it unless you pass `installIdProvider: false` (`src/session/router-session-service.ts`):

```ts
    if ((options.installIdProvider ?? true) && !installUrandomIdProvider()) {
      this.log({ level: "error", message: "Cannot read /dev/urandom; id provider not set, so event ids can repeat on a new microVM" });
    }
```

If you use a different session service, call `installUrandomIdProvider()` yourself at startup.

### Read the per-turn credentials

The Router sends two headers on every A2A request: `X-ACR-Token` (this turn's token) and `wd-tenant`. The token changes every turn. `src/index.ts` reads them in the `authentication` callback of `toA2a`, the first per-request hook, and `src/turn-credentials.ts` keeps them in `AsyncLocalStorage` so the model call, the tools, and the session service can read them:

```ts
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
```

The Router URL is fixed. It is `https://agent-harness.workday.com`, or `AC_ROUTER_URL` if set, and it never comes from a request header: the agent sends its token to this address, so a caller must not be able to choose it. An `X-Workday-URL` header is ignored. From `src/router-credentials.ts`:

```ts
export function resolveRouterUrl(): string {
  const configured = process.env.AC_ROUTER_URL?.trim();
  const value = configured ? configured : DEFAULT_ROUTER_URL;
```

`AC_ROUTER_URL` must be `https://`, except `localhost` or `127.0.0.1` for local testing.

### Call Workday tools through the Router

ADK's `MCPToolset` takes a fixed URL and fixed headers when it is built. That does not work here, because the token changes every turn. `src/router-mcp.ts` gives the toolset a custom `fetch` that sends each request to `<router>/sandbox/v1/mcp` with this turn's `x-acr-token` and `wd-tenant`:

```ts
export function routerMcpFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const { acRouterToken, wdTenant, routerUrl } = requireRouterCredentials();
    const headers = new Headers(init?.headers);
    headers.set("x-acr-token", acRouterToken);
    headers.set("wd-tenant", wdTenant);
    const url = `${routerUrl}${MCP_PATH}`;
```

```ts
export function createRouterMcpToolset(fetchImpl: typeof fetch = fetch): BaseToolset {
  return new OptionalToolset(
    new MCPToolset({
      type: "StreamableHTTPConnectionParams",
      url: PLACEHOLDER_URL,
      transportOptions: { fetch: routerMcpFetch(fetchImpl) },
    }),
  );
}
```

`src/agent.ts` adds the toolset to the agent:

```ts
  tools: [createRouterMcpToolset()],
```

`OptionalToolset` keeps the last successful tool list for 10 minutes, as one entry for one tenant (a turn for another tenant lists again), and gives the turn no tools (instead of failing it) when listing fails.

The Router returns only the tools that are listed in the agent card and whose skill is active. In `wd_agent_card.json`, list each tool under `workdayConfig[].workdayResources` with its `agent_resource` id, and use one skill only. More than one skill currently fails with `invalid_scope`.

```json
  "workdayConfig": [
    {
      "skillId": "expenses",
      "executionMode": {
        "id": "d785eba56e9c100035d336a043ff0000"
      },
      "workdayResources": [
        {
          "tool_name": "find_expense_lines",
          "description": "Retrieves a single expense report line by WID.",
          "agent_resource": {
            "id": "8797ce815d30100021e9f9365c9a0000"
          }
        },
```

### Fill in the agent card

`wd_agent_card.json` describes the agent to Workday:

- `name`, `description`, `overview`: what users see. `overview` is the agent's short self-description.
- `assistantName`: here it matches the `name` of the `LlmAgent` in `src/agent.ts` (`microvm_adk_agent`).
- `url`: a placeholder (`https://example.com/agent/expenses`).
- `version`: your agent's version.
- `provider.id`, `platform.id`, `agentFramework.id`: Workday ids for the provider, platform, and agent framework.
- `agentFrameworkVersion`: the framework version, `2.5.0` here. Keep it equal to the `@google/adk` version in `package.json`.
- `skills`: one skill (`id`, `name`, `description`).
- `workdayConfig`: per skill, the `executionMode` id and the `workdayResources` (tools), as above.

### When the Router is down

The turn continues, and errors are logged:

- Sessions: a create or append that fails with a network error, 408, 429, or 5xx is logged and queued for that session. The queue is sent, in order, on the next call for the session that has credentials. Any other 4xx is logged and the operation is dropped, not retried. A failed read is logged, and the turn runs without the stored history.
- Tools: if the tool list fails, a warning is logged and the turn runs with no tools.

Model inference also goes through the Router. If that call fails, `AcRouterLlm` throws and the turn fails.

### Dependencies

`@modelcontextprotocol/sdk` is an optional peer dependency of `@google/adk` 2.5, so npm does not install it with ADK. `MCPToolset` needs it, so `package.json` lists it explicitly. Keep it there if you copy this agent:

```json
  "dependencies": {
    "@a2a-js/sdk": "^0.3.14",
    "@google/adk": "^2.5.0",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "express": "^4.22.2"
  },
```

### Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `AC_ROUTER_URL` | No | `https://agent-harness.workday.com` | Router base URL, no path. `https://` only, except `localhost` for local testing. |
| `AC_ROUTER_MODEL` | No | `auto/auto` | Model id sent to the Router. `auto/auto` lets the platform pick. |
| `AC_ROUTER_TOKEN` | Local testing only | | Used when a request has no `X-ACR-Token` header. |
| `WD_TENANT` | Local testing only | | Used when a request has no `wd-tenant` header. |
| `PORT` | No | `8080` | Port for A2A and `/health`. |
| `A2A_HOST` | No | `0.0.0.0` | Host the A2A server binds and advertises. |

### Test locally with a stub Router

Start a stub that answers chat completions:

```js
// fake-ac-router.mjs
import { createServer } from "node:http";
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "hello!" } }] }));
  });
}).listen(9999);
```

```bash
node fake-ac-router.mjs &
AC_ROUTER_URL=http://localhost:9999 npm run dev
```

Check the server, then send a message with both headers:

```bash
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/.well-known/agent-card.json

curl --fail http://localhost:8080/jsonrpc \
  -H "content-type: application/json" \
  -H "x-acr-token: test-token" \
  -H "wd-tenant: test-tenant" \
  -d '{"jsonrpc":"2.0","method":"message/send","params":{"message":{"kind":"message","messageId":"m1","role":"user","parts":[{"kind":"text","text":"Hi, who are you?"}]},"configuration":{"blocking":true}},"id":1}'
```

The stub sends the same chat reply to every path, so the session and MCP calls do not get the answers they expect. The agent logs them and still replies.

## Before you deploy

- **Agent instruction and description**: `src/agent.ts` holds a generic Workday assistant instruction. Replace it with your agent's.
- **Logging**: `src/index.ts`, `src/ac-router-llm.ts`, and `src/router-mcp.ts` log request and response bodies (truncated), including prompts, model replies, and tool results, which can contain user data. Only the `X-ACR-Token` value and the `authorization`/`cookie` headers are redacted (`redactSecret` in `src/logger.ts`). Review and reduce this logging before production.
- **Agent card**: in `wd_agent_card.json`, change `name`, `description`, `overview`, `url`, `version`, and the skill to your agent's.
- **Tool ids**: the `agent_resource` ids under `workdayResources` in `wd_agent_card.json` register the sample's expenses tools. Keep the ones you use, remove the others, and add the ids of any other tools you need:
  - `find_expense_lines`: `8797ce815d30100021e9f9365c9a0000`
  - `find_expense_reports`: `b4018c35a49310000b0f815fa5290000`
  - `get_credit_card_transactions`: `6ead86b7d6e21000471dbda2f5380000`
  - `get_expense_reports`: `a96cd36887b610000c6cbbcfe7c80000`
  - `create_expense_lines`: `5dfbde16ae27100016135f2f47340000`
  - `submit_expense_report`: `6fe7738a2775100009aca237db7d0000`
  - `submit_expenses`: `cfb52c2d191e1000080923abaa740000`
  - `update_expense_lines`: `7b35460cf76910001d2975b2a5c80000`
  - `find_country_regions`: `e5958bc106f01000133136c020970000`
  - `find_expense_groups`: `2de27347374e1000254d1e875bf90000`
  - `find_expense_items`: `1f0fc252d8f51000290f6a63a8cc0000`
  - `find_expense_line_statuses`: `414806a0e0a1100012cc47c7d82f0000`
  - `find_expense_report_companies`: `b4018c35a493100015394ddab62d0000`
  - `find_expense_report_expense_items`: `628fae93b76f100034600ff76f840000`
  - `find_expense_report_payee_types`: `628fae93b76f1000345fbabd47fa0000`
  - `find_expense_report_payees`: `b4018c35a4931000153b498183040000`
  - `find_expense_report_payment_statuses`: `b4018c35a4931000153af870d7710000`
  - `find_expense_report_projects`: `b4018c35a4931000153c4615a3560000`
  - `find_expense_report_spend_categories`: `8ae31ef9740a10001eb0d7eb509a0000`
  - `find_expense_report_statuses`: `b4018c35a4931000153a91389c5f0000`
  - `find_frequently_used_countries`: `e5958bc106f01000133145c5c44b0000`
  - `find_ready_to_submit_expense_report_lines`: `e0b92ce1db7110002270f4b8abaa0000`
  - `find_travel_cities`: `e5958bc106f0100013254bc242200000`
- **Other card ids**: `provider.id`, `platform.id`, `agentFramework.id`, and `executionMode.id` in `wd_agent_card.json`. Check them against the values from the Early Access program.
- **Framework version**: if you change the `@google/adk` version in `package.json`, change `agentFrameworkVersion` in `wd_agent_card.json` to match.
- **Router URL**: `src/router-credentials.ts` sets `DEFAULT_ROUTER_URL` to `https://agent-harness.workday.com`. Leave it unless the program gives you another address; for local testing, set `AC_ROUTER_URL` instead of editing the code.
- **Package name**: `name` in `package.json` and `package-lock.json` is `custom-agent-adk-typescript`. Rename it to your agent's.
