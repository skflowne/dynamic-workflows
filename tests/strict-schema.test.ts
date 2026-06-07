import assert from "node:assert/strict";
import test from "node:test";
import { toStrictJsonSchema } from "../src/runners/codex-sdk.js";

test("toStrictJsonSchema enforces strict objects while preserving optional fields as nullable", () => {
  const strict = toStrictJsonSchema({
    type: "object",
    properties: { a: { type: "string" }, b: { type: "number" } },
    required: ["a"],
  }) as any;

  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ["a", "b"]); // all keys become required for OpenAI strict mode
  assert.deepEqual(strict.properties.a, { type: "string" });
  assert.deepEqual(strict.properties.b, { type: ["number", "null"] });
});

test("toStrictJsonSchema recurses into array items and anyOf branches", () => {
  const strict = toStrictJsonSchema({
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object", properties: { q: { type: "string" } } } },
      choice: {
        anyOf: [
          { type: "object", properties: { x: { type: "number" } } },
          { type: "string" },
        ],
      },
    },
  }) as any;

  assert.equal(strict.properties.items.items.additionalProperties, false);
  assert.deepEqual(strict.properties.items.items.required, ["q"]);
  assert.deepEqual(strict.properties.items.items.properties.q.type, ["string", "null"]);
  assert.equal(strict.properties.choice.anyOf[0].additionalProperties, false);
  assert.deepEqual(strict.properties.choice.anyOf[0].required, ["x"]);
  assert.deepEqual(strict.properties.choice.anyOf[0].properties.x.type, ["number", "null"]);
  assert.equal(strict.properties.choice.anyOf[1].type, "string"); // non-object untouched
});

test("toStrictJsonSchema leaves non-object schemas and is idempotent", () => {
  assert.deepEqual(toStrictJsonSchema({ type: "string" }), { type: "string" });

  const once = toStrictJsonSchema({ type: "object", properties: { a: { type: "string" } } });
  const twice = toStrictJsonSchema(once);
  assert.deepEqual(twice, once);
});
