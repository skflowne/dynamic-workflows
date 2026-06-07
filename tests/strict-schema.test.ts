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
