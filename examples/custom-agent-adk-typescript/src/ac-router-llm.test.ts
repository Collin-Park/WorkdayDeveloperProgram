import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { LlmRequest } from "@google/adk";
import { AcRouterLlm } from "./ac-router-llm.js";
import { withTurnCredentials } from "./turn-credentials.js";

const ORIGINAL_ENV = { ...process.env };
const WORKDAY_URL = "https://ac-router.example.com";

beforeEach(() => {
  process.env.AC_ROUTER_TOKEN = "test-token";
  process.env.WD_TENANT = "acme-corp";
  process.env.AC_ROUTER_URL = WORKDAY_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function makeRequest(text: string): LlmRequest {
  return {
    contents: [{ role: "user", parts: [{ text }] }],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

async function collect<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

// beforeEach points AC_ROUTER_URL at WORKDAY_URL so no test calls the real
// default address; the two tests that exercise the default clear it.

test("sends the AC_ROUTER_TOKEN and wd-tenant headers, forwards the model + messages", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi there" } }] }), {
      status: 200,
    });
  }) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });

  const responses = await withTurnCredentials({}, () =>
    collect(llm.generateContentAsync(makeRequest("hello"))),
  );

  assert.equal(responses.length, 1);
  assert.equal(responses[0].content?.parts?.[0]?.text, "hi there");
  assert.equal(responses[0].turnComplete, true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ac-router.example.com/sandbox/v1/chat/completions");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-acr-token"], "test-token");
  assert.equal(headers["wd-tenant"], "acme-corp");

  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.model, "aviato-turbo/aviato-turbo");
  assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
});

test("raises when AC_ROUTER_TOKEN is missing", async () => {
  delete process.env.AC_ROUTER_TOKEN;
  const llm = new AcRouterLlm({
    model: "aviato-turbo/aviato-turbo",
    fetchImpl: (async () => {
      throw new Error("fetch should not be called");
    }) as typeof fetch,
  });

  await assert.rejects(
    () => collect(llm.generateContentAsync(makeRequest("hello"))),
    /AC_ROUTER_TOKEN is not available/,
  );
});

test("raises when WD_TENANT is missing", async () => {
  delete process.env.WD_TENANT;
  const llm = new AcRouterLlm({
    model: "aviato-turbo/aviato-turbo",
    fetchImpl: (async () => {
      throw new Error("fetch should not be called");
    }) as typeof fetch,
  });

  await assert.rejects(
    () => collect(llm.generateContentAsync(makeRequest("hello"))),
    /wd-tenant is not available/,
  );
});

test("calls https://agent-harness.workday.com when AC_ROUTER_URL is not set", async () => {
  delete process.env.AC_ROUTER_URL;
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
  }) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });
  await collect(llm.generateContentAsync(makeRequest("hello")));

  assert.deepEqual(calls, ["https://agent-harness.workday.com/sandbox/v1/chat/completions"]);
});

test("ignores an X-Workday-URL header: the Router address never comes from the request", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
  }) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });
  // A stale or hostile value, as a header-capturing build would have stored it.
  const turn = { workdayUrl: "https://attacker.example" } as Record<string, string>;
  await withTurnCredentials(turn, () => collect(llm.generateContentAsync(makeRequest("hello"))));

  assert.deepEqual(calls, [`${WORKDAY_URL}/sandbox/v1/chat/completions`]);
});

test("raises before any network call when AC_ROUTER_URL is not https", async () => {
  process.env.AC_ROUTER_URL = "http://router.example.com";
  const llm = new AcRouterLlm({
    model: "aviato-turbo/aviato-turbo",
    fetchImpl: (async () => {
      throw new Error("fetch should not be called");
    }) as typeof fetch,
  });

  await assert.rejects(() => collect(llm.generateContentAsync(makeRequest("hello"))), /AC_ROUTER_URL must be https/);
});

test("forwards systemInstruction as a system message, not a user message", async () => {
  const calls: Array<{ init: RequestInit }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({ init });
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi there" } }] }), {
      status: 200,
    });
  }) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });

  const request: LlmRequest = {
    ...makeRequest("hello"),
    config: { systemInstruction: "Reply with a short, friendly one-sentence greeting." },
  };
  await withTurnCredentials({}, () =>
    collect(llm.generateContentAsync(request)),
  );

  const body = JSON.parse(calls[0].init.body as string);
  assert.deepEqual(body.messages, [
    { role: "system", content: "Reply with a short, friendly one-sentence greeting." },
    { role: "user", content: "hello" },
  ]);
});

test("prefers per-request turn credentials over environment variables", async () => {
  process.env.AC_ROUTER_TOKEN = "env-token";
  process.env.WD_TENANT = "env-tenant";

  const calls: Array<{ init: RequestInit }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({ init });
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi there" } }] }), {
      status: 200,
    });
  }) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });

  await withTurnCredentials(
    { acRouterToken: "turn-token", wdTenant: "turn-tenant" },
    () => collect(llm.generateContentAsync(makeRequest("hello"))),
  );

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-acr-token"], "turn-token");
  assert.equal(headers["wd-tenant"], "turn-tenant");
});

test("falls back to environment variables for the token/tenant when the turn carries neither", async () => {
  const calls: Array<{ init: RequestInit }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({ init });
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi there" } }] }), {
      status: 200,
    });
  }) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });

  // Deliberately omits acRouterToken/wdTenant from the turn-credentials
  // object -- proves the env-var fallback (for local testing) still
  // works for those two fields.
  await withTurnCredentials({}, () =>
    collect(llm.generateContentAsync(makeRequest("hello"))),
  );

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-acr-token"], "test-token");
  assert.equal(headers["wd-tenant"], "acme-corp");
});

test("raises on a non-2xx response from the Router", async () => {
  const fetchImpl = (async () =>
    new Response("missing wd-tenant header", { status: 400 })) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });

  await withTurnCredentials({}, () =>
    assert.rejects(() => collect(llm.generateContentAsync(makeRequest("hello"))), /HTTP 400/),
  );
});

test("does not leak the upstream response body into the thrown error", async () => {
  // If the Router forwards a verbose/sensitive upstream error body verbatim, it
  // must not leak into whatever logs Node/ADK write for an uncaught error.
  const sensitiveBody = "upstream error for tenant acme-corp, apiKey=sk-live-abc123";
  const fetchImpl = (async () => new Response(sensitiveBody, { status: 502 })) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });

  await withTurnCredentials({}, async () => {
    try {
      await collect(llm.generateContentAsync(makeRequest("hello")));
      assert.fail("expected generateContentAsync to throw");
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      assert.equal(messageText, "AC Router inference call failed: HTTP 502");
      assert.ok(!messageText.includes("sk-live-abc123"), "thrown message must not include the upstream body");
    }
  });
});

test("raises when the Router returns an empty choices array", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });

  await withTurnCredentials({}, () =>
    assert.rejects(
      () => collect(llm.generateContentAsync(makeRequest("hello"))),
      /choices\[0\]\.message\.content is empty/,
    ),
  );
});

test("raises when the Router returns a choice with empty message content", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });

  await withTurnCredentials({}, () =>
    assert.rejects(
      () => collect(llm.generateContentAsync(makeRequest("hello"))),
      /choices\[0\]\.message\.content is empty/,
    ),
  );
});

test("raises with context when the Router returns a non-JSON body", async () => {
  const fetchImpl = (async () => new Response("<html>502 Bad Gateway</html>", { status: 200 })) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl });

  await withTurnCredentials({}, () =>
    assert.rejects(
      () => collect(llm.generateContentAsync(makeRequest("hello"))),
      /AC Router returned HTTP 200 with a non-JSON body/,
    ),
  );
});

test("aborts and throws when the Router does not respond within the configured timeout", async () => {
  const fetchImpl = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new Error("simulated network abort")));
    })) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl, timeoutMs: 10 });

  await withTurnCredentials({}, () =>
    assert.rejects(
      () => collect(llm.generateContentAsync(makeRequest("hello"))),
      /AC Router call timed out after 10ms/,
    ),
  );
});

test("does not time out when the Router responds before the deadline", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "hi there" } }] }), {
      status: 200,
    })) as typeof fetch;

  const llm = new AcRouterLlm({ model: "aviato-turbo/aviato-turbo", fetchImpl, timeoutMs: 10 });

  const responses = await withTurnCredentials({}, () =>
    collect(llm.generateContentAsync(makeRequest("hello"))),
  );
  assert.equal(responses[0].content?.parts?.[0]?.text, "hi there");
});
