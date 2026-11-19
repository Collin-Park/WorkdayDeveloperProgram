import assert from "node:assert/strict";
import { test } from "node:test";
import { rootAgent } from "./agent.js";
import { AcRouterLlm } from "./ac-router-llm.js";
import { OptionalToolset } from "./router-mcp.js";

test(
  "the agent defaults to auto/auto when AC_ROUTER_MODEL is unset",
  { skip: process.env.AC_ROUTER_MODEL !== undefined },
  () => {
    assert.ok(rootAgent.model instanceof AcRouterLlm);
    assert.equal(rootAgent.model.model, "auto/auto");
  },
);

test("the agent gets the Router MCP tools, wrapped so a turn without MCP access still works", () => {
  assert.equal(rootAgent.tools.length, 1);
  assert.ok(rootAgent.tools[0] instanceof OptionalToolset);
});
