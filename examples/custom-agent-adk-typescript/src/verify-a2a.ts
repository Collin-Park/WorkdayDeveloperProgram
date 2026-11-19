import { randomUUID } from "node:crypto";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import type { AgentCard, AgentInterface, Message, Task } from "@a2a-js/sdk";

// `toA2a()` bakes whatever host the `A2A_HOST` env var says into the
// AgentCard's own `url`/`additionalInterfaces` (see index.ts) -- for a
// MicroVM that's "0.0.0.0" (the bind address, not a routable destination),
// since the MicroVM's real hostname is assigned only when it starts.
// `@a2a-js/sdk`'s `ClientFactory` trusts the card's advertised URL literally
// for the actual JSON-RPC calls (so `/health` and the agent card succeed, but
// a real `sendMessage` -- which goes through the card's `url` -- fails with
// "fetch failed" against 0.0.0.0). Rewriting the card's URLs to the base URL
// this client already reached (keeping only the path) sidesteps that without
// touching the server. A real caller (e.g. the Router itself) does the same,
// since it already knows the real endpoint.
class RebasingAgentCardResolver implements AgentCardResolverInterface {
  constructor(
    private readonly inner: AgentCardResolverInterface,
    private readonly realBaseUrl: string,
  ) {}

  async resolve(baseUrl: string, path?: string): Promise<AgentCard> {
    const card = await this.inner.resolve(baseUrl, path);
    const rebase = (url: string) => new URL(new URL(url).pathname, this.realBaseUrl).toString();
    const additionalInterfaces = card.additionalInterfaces?.map(
      (iface: AgentInterface) => ({ ...iface, url: rebase(iface.url) }),
    );
    return { ...card, url: rebase(card.url), additionalInterfaces };
  }
}

interface AgentCardResolverInterface {
  resolve(baseUrl: string, path?: string): Promise<AgentCard>;
}

// One-shot CLI check that a running instance of this agent (local dev
// server, or a running MicroVM) actually completes a turn over A2A.
//
// Usage:
//   A2A_URL=http://localhost:8080 npm run verify-a2a -- "hello there"
//
// Against a MicroVM reached through the platform's authenticated proxy (not a
// raw routable port), set MICROVM_PROXY_AUTH_TOKEN to that proxy's auth token
// so every request carries the `X-aws-proxy-auth` header it requires.

async function main(): Promise<void> {
  const baseUrl = process.env.A2A_URL ?? "http://localhost:8080";
  const message = process.argv[2] ?? "Hello from verify-a2a!";
  const proxyAuthToken = process.env.MICROVM_PROXY_AUTH_TOKEN;

  const fetchImpl: typeof fetch = proxyAuthToken
    ? ((url, init = {}) =>
        fetch(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string> | undefined), "X-aws-proxy-auth": proxyAuthToken },
        })) as typeof fetch
    : fetch;

  console.log(`Sending A2A message to ${baseUrl} ...`);
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new RebasingAgentCardResolver(new DefaultAgentCardResolver({ fetchImpl }), baseUrl),
  });
  const client = await factory.createFromUrl(baseUrl);

  const result = await client.sendMessage({
    message: {
      kind: "message",
      messageId: randomUUID(),
      role: "user",
      parts: [{ kind: "text", text: message }],
    },
  });

  const replyText = extractReplyText(result);
  console.log(`Reply: ${replyText ?? "<no text part found>"}`);
  console.log(JSON.stringify(result, null, 2));

  // A Task in a terminal "failed" state still carries its error as ordinary
  // reply text (e.g. the agent's own caught exception message, like a
  // downstream "fetch failed") -- `extractReplyText` finding *some* text is
  // not the same as the turn having succeeded.
  if (result.kind === "task" && result.status.state === "failed") {
    throw new Error(`RESULT: FAIL -- task failed: ${replyText ?? "<no error text found>"}`);
  }
  if (!replyText) {
    throw new Error("RESULT: FAIL -- no text reply found in the A2A response.");
  }
  console.log("RESULT: PASS");
}

function extractReplyText(result: Message | Task): string | undefined {
  if (result.kind === "message") {
    return textFromParts(result.parts);
  }
  // A completed Task carries its reply as an artifact, not `status.message`
  // (ADK's A2AAgentExecutor publishes the model's output as
  // a TaskArtifactUpdateEvent, only using `status.message` for
  // input-required/failed states). Check both so this doesn't silently
  // regress if that ever changes.
  const fromStatusMessage = result.status.message && textFromParts(result.status.message.parts);
  if (fromStatusMessage) return fromStatusMessage;
  for (const artifact of result.artifacts ?? []) {
    const text = textFromParts(artifact.parts);
    if (text) return text;
  }
  return undefined;
}

function textFromParts(parts: Array<{ kind: string; text?: string }>): string | undefined {
  const textPart = parts.find((part) => part.kind === "text");
  return textPart?.text;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
