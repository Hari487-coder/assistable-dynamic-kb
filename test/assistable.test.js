import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistableClient } from "../src/assistable/client.js";
import { buildToolDefinition } from "../src/assistable/tool-def.js";

const noopLog = { info() {}, warn() {}, error() {} };

test("mock client records calls and returns ids", async () => {
  const c = new AssistableClient({ apiKey: "k", mock: true, logger: noopLog });
  const created = await c.createTool({ name: "live_data_inventory" });
  assert.match(created.id, /^mock-tool-/);
  assert.equal(c.mockCalls[0].method, "POST");
  assert.equal(c.mockCalls[0].path, "/v3/tools");
});

test("real client unwraps envelope and sends the Bearer auth header", async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { status: 200, json: async () => ({ data: [{ id: "a1", name: "Riva" }], error: null, request_id: "r" }) };
  };
  const c = new AssistableClient({ apiKey: "sek", base: "https://api.test", mock: false, logger: noopLog, fetchImpl });
  const assistants = await c.listAssistants();
  assert.equal(assistants[0].id, "a1");
  // Verified in platform source (managed-api-key-auth.ts:67-77): the v3 API
  // reads ONLY `Authorization: Bearer`. x-api-key was never honoured.
  assert.equal(captured.opts.headers["authorization"], "Bearer sek");
  assert.ok(!("x-api-key" in captured.opts.headers));
  assert.ok(!captured.url.includes("include_archived"), "must omit include_archived (coercion footgun)");
});

test("409 on createTool retries with suffixed name", async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return bodies.length === 1
      ? { status: 409, json: async () => ({ data: null, error: { code: "conflict" } }) }
      : { status: 201, json: async () => ({ data: { id: "t2" }, error: null }) };
  };
  const c = new AssistableClient({ apiKey: "k", base: "https://api.test", mock: false, logger: noopLog, fetchImpl });
  const r = await c.createTool({ name: "live_data_inv" });
  assert.equal(r.id, "t2");
  assert.equal(bodies[1].name, "live_data_inv-2");
});

test("buildToolDefinition: flat stable schema with sentinels", () => {
  const source = { id: "s1", name: "Riverside Inventory" };
  const meta = [
    { name: "make", kind: "categorical", distincts: ["Toyota", "Honda", "Chevrolet"] },
    { name: "model", kind: "categorical", distincts: ["Tacoma", "Civic", "Silverado"] },
    { name: "year", kind: "numeric", min: 2021, max: 2023 },
    { name: "price", kind: "numeric", min: 19900, max: 41000 },
    { name: "vin", kind: "text" },
  ];
  const def = buildToolDefinition(source, meta, { baseUrl: "https://kb.example.com", secret: "shh" });
  assert.match(def.name, /^live_data_[a-zA-Z0-9_-]+$/);
  assert.ok(def.name.length <= 64);
  assert.equal(def.tool_type, "FUNCTION");
  assert.equal(def.url, "https://kb.example.com/api/tools/s1/search");
  assert.equal(def.headers["x-bridge-secret"], "shh");
  const props = def.parameters.properties;
  assert.ok(props.query);
  assert.ok(props.make.description.includes("Toyota"));
  assert.ok(props.price_min && props.price_max);
  assert.ok(!props.vin, "text cols excluded");
  assert.match(props.make.description, /""/);
  assert.match(def.description, /ALWAYS call/);
});
