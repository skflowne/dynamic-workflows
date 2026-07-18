import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, toStrictJsonSchema } from "../src/runners/codex-sdk.js";
import type { WorkflowAgentCall, WorkflowAgentOptions } from "../src/index.js";

function makeCall(prompt: string, options: WorkflowAgentOptions = {}): WorkflowAgentCall {
  return { prompt, options, index: 1, runId: "wf_test", cacheKey: "k" };
}

test("buildPrompt injects the verbatim-return discipline and stays prose-only without a schema", () => {
  const prompt = buildPrompt(makeCall("do the thing"), undefined, false);
  assert.match(prompt, /returned verbatim as this agent\(\) call's result/);
  assert.match(prompt, /not a message to a human/);
  assert.match(prompt, /do not add confirmations like "Done\."/);
  assert.match(prompt, /Be concise/);
  assert.doesNotMatch(prompt, /Structured output contract/);
  assert.ok(prompt.includes("do the thing"));
});

test("buildPrompt adds the strict JSON contract when a schema is present", () => {
  const prompt = buildPrompt(makeCall("extract", { schema: { type: "object" } }), undefined, false);
  assert.match(prompt, /Structured output contract:/);
  assert.match(prompt, /You MUST return ONLY JSON/);
  assert.match(prompt, /If your output fails schema validation the call fails/);
  // Codex sends the schema as a native parameter, so it must NOT also be embedded in the prompt.
  assert.doesNotMatch(prompt, /JSON Schema your output must satisfy/);
});

test("buildPrompt describes worktree isolation as preserve-on-change", () => {
  const prompt = buildPrompt(makeCall("edit", { isolation: "worktree" }), undefined, true);
  assert.match(prompt, /isolated git worktree/);
  assert.match(prompt, /preserved for review if you do/);
  assert.doesNotMatch(prompt, /discarded when this agent finishes/);
});

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

test("toStrictJsonSchema preserves a schema-valued additionalProperties (map/Record type)", () => {
  const strict = toStrictJsonSchema({
    type: "object",
    additionalProperties: { type: "string" },
  }) as any;

  // Must NOT be forced to `false` — that would silently restrict the model to emitting `{}`.
  assert.deepEqual(strict.additionalProperties, { type: "string" });
});

test("toStrictJsonSchema recursively strictifies a schema-valued additionalProperties", () => {
  const strict = toStrictJsonSchema({
    type: "object",
    additionalProperties: { type: "object", properties: { q: { type: "string" } } },
  }) as any;

  assert.equal(strict.additionalProperties.additionalProperties, false);
  assert.deepEqual(strict.additionalProperties.required, ["q"]);
  assert.deepEqual(strict.additionalProperties.properties.q.type, ["string", "null"]);
});

test("toStrictJsonSchema still forces additionalProperties:false for a boolean/absent original", () => {
  const strict = toStrictJsonSchema({
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
  }) as any;
  assert.equal(strict.additionalProperties, false);

  const strictBoolTrue = toStrictJsonSchema({
    type: "object",
    additionalProperties: true,
    properties: { a: { type: "string" } },
    required: ["a"],
  }) as any;
  assert.equal(strictBoolTrue.additionalProperties, false);
});

test("toStrictJsonSchema appends null to enum for an optional enum field", () => {
  const strict = toStrictJsonSchema({
    type: "object",
    properties: { color: { type: "string", enum: ["red", "green", "blue"] } },
    required: [],
  }) as any;

  assert.deepEqual(strict.properties.color.enum, ["red", "green", "blue", null]);
  assert.deepEqual(strict.properties.color.type, ["string", "null"]);
});

test("toStrictJsonSchema converts an optional const field to a nullable enum", () => {
  const strict = toStrictJsonSchema({
    type: "object",
    properties: { kind: { const: "widget" } },
    required: [],
  }) as any;

  assert.equal(strict.properties.kind.const, undefined);
  assert.deepEqual(strict.properties.kind.enum, ["widget", null]);
});

test("toStrictJsonSchema leaves a required enum/const field untouched", () => {
  const strict = toStrictJsonSchema({
    type: "object",
    properties: {
      color: { type: "string", enum: ["red", "green"] },
      kind: { const: "widget" },
    },
    required: ["color", "kind"],
  }) as any;

  assert.deepEqual(strict.properties.color.enum, ["red", "green"]);
  assert.equal(strict.properties.color.type, "string");
  assert.equal(strict.properties.kind.const, "widget");
});

test("toStrictJsonSchema treats $defs/definitions/patternProperties as maps of subschemas, even with adversarial def names", () => {
  const strict = toStrictJsonSchema({
    type: "object",
    properties: { thing: { $ref: "#/$defs/properties" } },
    required: ["thing"],
    $defs: {
      // A def literally named "properties" must not be mistaken for this node's own `properties`
      // map (which would run its schema body through strictifyProperties and wrap "type"/"required"
      // etc. as if they were named subfields).
      properties: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      required: { type: "string" },
    },
  }) as any;

  // The $defs container itself must not have gained an additionalProperties key of its own.
  assert.equal(strict.$defs.additionalProperties, undefined);

  // Each def's own subschema is strictified normally, keyed by its own (structurally untouched) name
  // — including a def literally named "required", which must stay a plain (untouched) subschema
  // rather than being mistaken for the container's own `required` array.
  assert.equal(strict.$defs.properties.additionalProperties, false);
  assert.deepEqual(strict.$defs.properties.required, ["a"]);
  assert.equal(strict.$defs.properties.properties.a.type, "string"); // "a" is required, stays non-nullable
  assert.deepEqual(strict.$defs.required, { type: "string" });

  const definitionsStrict = toStrictJsonSchema({
    definitions: { properties: { type: "string" } },
  }) as any;
  assert.deepEqual(definitionsStrict.definitions.properties, { type: "string" });

  const patternPropsStrict = toStrictJsonSchema({
    type: "object",
    patternProperties: { "^S_": { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
  }) as any;
  assert.equal(patternPropsStrict.patternProperties["^S_"].additionalProperties, false);
  assert.deepEqual(patternPropsStrict.patternProperties["^S_"].required, ["a"]);
});

test("toStrictJsonSchema stays idempotent with additionalProperties schema, enum, and $defs", () => {
  const schema = {
    type: "object",
    properties: {
      color: { type: "string", enum: ["red", "green"] },
      kind: { const: "widget" },
      extra: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["color"],
    $defs: { Foo: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } },
  };
  const once = toStrictJsonSchema(schema);
  const twice = toStrictJsonSchema(once);
  assert.deepEqual(twice, once);
});

test("strip-null round-trip: strict copy's nullable-enum/const fields still validate against the original loose schema", async () => {
  const { Ajv } = await import("ajv/dist/ajv.js");
  const looseSchema = {
    type: "object",
    properties: {
      color: { type: "string", enum: ["red", "green"] },
      kind: { const: "widget" },
      name: { type: "string" },
    },
    required: ["name"],
  } as const;

  const strict = toStrictJsonSchema(looseSchema) as any;
  // Simulate what the model would return against the strict copy when it omits optional fields
  // (nulls for the fields the strict copy made nullable).
  const modelOutput = { color: null, kind: null, name: "n" };
  assert.equal(strict.properties.color.type[1], "null");
  assert.equal(strict.properties.kind.enum[1], null);

  // stripNullOptionalFields (runtime.ts) removes null optional fields before validating against the
  // ORIGINAL loose schema — replicate that here since it's not exported, to confirm the two stay
  // compatible after the B1/B2/B3 strict-copy changes.
  const stripped: Record<string, unknown> = { ...modelOutput };
  const required = new Set((looseSchema.required as readonly string[]) ?? []);
  for (const [key, value] of Object.entries(modelOutput)) {
    if (value === null && !required.has(key)) delete stripped[key];
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(looseSchema);
  assert.ok(validate(stripped), ajv.errorsText(validate.errors));
});
