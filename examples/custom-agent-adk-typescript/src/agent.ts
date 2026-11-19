import { LlmAgent } from "@google/adk";
import { AcRouterLlm } from "./ac-router-llm.js";
import { createRouterMcpToolset } from "./router-mcp.js";

const model = process.env.AC_ROUTER_MODEL ?? "auto/auto";

export const rootAgent = new LlmAgent({
  name: "microvm_adk_agent",
  model: new AcRouterLlm({ model }),
  description:
    "Template Custom Agent: answers through the platform's model inference and uses Workday tools through the Router's MCP route.",
  instruction:
    "You are a Workday assistant. When the user asks about their Workday data, use the available " +
    "tools and answer from their results. If no tool fits, or no tools are available, reply with a " +
    "short, friendly sentence.",
  tools: [createRouterMcpToolset()],
});
