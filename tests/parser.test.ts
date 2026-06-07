import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowScript, WorkflowInputError } from "../src/index.js";

test("parseWorkflowScript extracts literal metadata and body", () => {
  const parsed = parseWorkflowScript(`export const meta = {
  name: 'demo',
  description: 'Demo workflow',
  whenToUse: 'tests',
  phases: [{ title: 'Scope', detail: 'Collect inputs' }]
}

phase('Scope')
return { ok: true }
`);

  assert.equal(parsed.meta.name, "demo");
  assert.equal(parsed.meta.description, "Demo workflow");
  assert.deepEqual(parsed.meta.phases, [{ title: "Scope", detail: "Collect inputs" }]);
  assert.match(parsed.body, /phase\('Scope'\)/);
  assert.doesNotMatch(parsed.body, /export const meta/);
});

test("parseWorkflowScript rejects non-literal and unsafe metadata", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: makeName(), description: 'desc' }"),
    WorkflowInputError,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { ['name']: 'demo', description: 'desc' }"),
    /computed keys not allowed/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { __proto__: {}, name: 'demo', description: 'desc' }"),
    /reserved key name/,
  );
});

test("parseWorkflowScript accepts open TS/JS workflow bodies", () => {
  const parsed = parseWorkflowScript(`export const meta: { name: string; description: string } = {
  name: 'open',
  description: 'Open workflow'
} as const

import path, { basename as base } from 'node:path'
import type { Stats } from 'node:fs'
type Local = { value: string }
export const helper = 1
return {
  random: Math.random(),
  now: Date.now(),
  date: new Date(),
  base: base(path.join('a', 'b')),
} satisfies Local | object
`);

  assert.equal(parsed.meta.name, "open");
  assert.match(parsed.body, /await import\("node:path"\)/);
  assert.doesNotMatch(parsed.body, /import type/);
  assert.match(parsed.body, /const helper = 1/);
  assert.match(parsed.body, /Math\.random/);
  assert.match(parsed.body, /Date\.now/);
});

test("parseWorkflowScript transforms re-exports without leaving dangling tokens", () => {
  const parsed = parseWorkflowScript(`export const meta = { name: 're_exports', description: 'Re-export forms' }

const a = 1
const b = 2
export { a, b }
export * from 'node:os'
export * as ns from 'node:path'
export type { Stats } from 'node:fs'
return { a, b }
`);

  // Local re-export erases but the const declarations remain usable.
  assert.match(parsed.body, /const a = 1/);
  assert.doesNotMatch(parsed.body, /export\s*\{/);
  // `export * from`/`export * as ns from` keep a side-effect import.
  assert.match(parsed.body, /await import\("node:os"\)/);
  assert.match(parsed.body, /await import\("node:path"\)/);
  // `export type ... from` is fully erased — no runtime import of a type-only module.
  assert.doesNotMatch(parsed.body, /await import\("node:fs"\)/);
});

test("parseWorkflowScript binds anonymous default exports to a name", () => {
  const fn = parseWorkflowScript(`export const meta = { name: 'def_fn', description: 'd' }
export default function () { return 1 }
return 1
`);
  assert.match(fn.body, /const __workflow_default_export = function/);

  const cls = parseWorkflowScript(`export const meta = { name: 'def_cls', description: 'd' }
export default class { method() {} }
return 1
`);
  assert.match(cls.body, /const __workflow_default_export = class/);

  const named = parseWorkflowScript(`export const meta = { name: 'def_named', description: 'd' }
export default function helper() { return 1 }
return helper()
`);
  // A named default declaration stays a valid statement.
  assert.match(named.body, /function helper\(\)/);
  assert.doesNotMatch(named.body, /__workflow_default_export/);
});

test("parseWorkflowScript permits prompts mentioning nondeterministic names", () => {
  const parsed = parseWorkflowScript(`export const meta = {
  name: 'mentions',
  description: 'Mentions Date.now() and Math.random()'
}

return agent('Find Date.now(), Math.random(), and new Date() mentions')
`);

  assert.match(parsed.body, /Date\.now/);
});
