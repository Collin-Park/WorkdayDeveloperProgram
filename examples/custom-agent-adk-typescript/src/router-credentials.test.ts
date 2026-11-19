import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_ROUTER_URL, resolveRouterUrl } from "./router-credentials.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test("defaults to the public agent-harness name", () => {
  delete process.env.AC_ROUTER_URL;
  assert.equal(DEFAULT_ROUTER_URL, "https://agent-harness.workday.com");
  assert.equal(resolveRouterUrl(), "https://agent-harness.workday.com");
});

test("an empty or blank AC_ROUTER_URL falls back to the default", () => {
  process.env.AC_ROUTER_URL = "  ";
  assert.equal(resolveRouterUrl(), DEFAULT_ROUTER_URL);
});

test("AC_ROUTER_URL overrides the default, with trailing slashes removed", () => {
  process.env.AC_ROUTER_URL = "https://router.example.com//";
  assert.equal(resolveRouterUrl(), "https://router.example.com");
});

test("http is allowed only for a loopback address", () => {
  process.env.AC_ROUTER_URL = "http://localhost:9999";
  assert.equal(resolveRouterUrl(), "http://localhost:9999");
  process.env.AC_ROUTER_URL = "http://127.0.0.1:9999/";
  assert.equal(resolveRouterUrl(), "http://127.0.0.1:9999");
  process.env.AC_ROUTER_URL = "http://router.example.com";
  assert.throws(resolveRouterUrl, /must be https/);
});

test("rejects a value that is not a URL, and non-http schemes", () => {
  process.env.AC_ROUTER_URL = "agent-harness.workday.com";
  assert.throws(resolveRouterUrl, /not a valid URL/);
  process.env.AC_ROUTER_URL = "ftp://router.example.com";
  assert.throws(resolveRouterUrl, /must be https/);
});
