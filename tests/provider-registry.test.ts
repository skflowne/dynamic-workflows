import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunnerResolver,
  InMemoryWorkflowJournal,
  runWorkflow,
  validateProvidersConfig,
} from "../src/index.js";
import type { ProviderRunnerFactories, ProvidersConfig, WorkflowAgentRunner } from "../src/index.js";

/** Fake factories that record which (provider, effectiveModel) each resolution asked to build. */
function recorder() {
  const forProviderCalls: { name: string; model: string | undefined }[] = [];
  const factories: ProviderRunnerFactories = {
    forProvider(name, _def, effectiveModel) {
      forProviderCalls.push({ name, model: effectiveModel });
      return { async run() { return `p:${name}:${effectiveModel ?? ""}`; } } satisfies WorkflowAgentRunner;
    },
  };
  return { factories, forProviderCalls };
}

const CONFIG: ProvidersConfig = validateProvidersConfig(
  {
    providers: {
      "codex-default": { backend: "codex", model: "gpt-5-codex" },
      "claude-smart": { backend: "pi", model: "claude-opus-4-8" },
      "gemini-pro": { backend: "gemini", model: "gemini-2.5-pro" },
      "claude-alt": { backend: "pi", model: "claude-opus-4-8" }, // shares a model id with claude-smart
    },
    default: "codex-default",
  },
  "test",
);

test("resolves by provider name (repeat calls reuse one cached runner)", () => {
  const { factories, forProviderCalls } = recorder();
  const resolve = buildRunnerResolver(CONFIG, factories);
  const first = resolve({ provider: "claude-smart" });
  const second = resolve({ provider: "claude-smart" });
  assert.equal(first, second);
  assert.deepEqual(forProviderCalls, [{ name: "claude-smart", model: "claude-opus-4-8" }]);
});

test("an explicit model overrides the provider's default model", () => {
  const { factories, forProviderCalls } = recorder();
  const resolve = buildRunnerResolver(CONFIG, factories);
  resolve({ provider: "claude-smart", model: "claude-haiku-4-5" });
  assert.deepEqual(forProviderCalls, [{ name: "claude-smart", model: "claude-haiku-4-5" }]);
});

test("routes by model id and sends that model to the backend", () => {
  const { factories, forProviderCalls } = recorder();
  const resolve = buildRunnerResolver(CONFIG, factories);
  resolve({ model: "gemini-2.5-pro" });
  assert.deepEqual(forProviderCalls, [{ name: "gemini-pro", model: "gemini-2.5-pro" }]);
});

test("ambiguous model throws unless the default provider serves it", () => {
  const { factories } = recorder();
  // claude-opus-4-8 is served by claude-smart AND claude-alt; default (codex) does not serve it → ambiguous.
  const resolve = buildRunnerResolver(CONFIG, factories);
  assert.throws(() => resolve({ model: "claude-opus-4-8" }), /served by multiple providers/);

  const withDefault = validateProvidersConfig(
    {
      providers: {
        a: { backend: "pi", model: "m" },
        b: { backend: "pi", model: "m" },
      },
      default: "a",
    },
    "test",
  );
  const { factories: f2, forProviderCalls } = recorder();
  buildRunnerResolver(withDefault, f2)({ model: "m" });
  assert.deepEqual(forProviderCalls, [{ name: "a", model: "m" }]);
});

test("an unrecognized model falls through to the default (model ignored)", () => {
  const { factories, forProviderCalls } = recorder();
  const resolve = buildRunnerResolver(CONFIG, factories);
  resolve({ model: "no-such-model" });
  assert.deepEqual(forProviderCalls, [{ name: "codex-default", model: "gpt-5-codex" }]);
});

test("run-level default provider wins when an agent specifies nothing", () => {
  const { factories, forProviderCalls } = recorder();
  const resolve = buildRunnerResolver(CONFIG, factories, { defaultProvider: "gemini-pro" });
  resolve({});
  assert.deepEqual(forProviderCalls, [{ name: "gemini-pro", model: "gemini-2.5-pro" }]);
});

test("an agent that resolves to nothing (no provider/model/default) throws", () => {
  const noDefault = validateProvidersConfig({ providers: { a: { backend: "codex", model: "m" } } }, "test");
  const { factories } = recorder();
  const resolve = buildRunnerResolver(noDefault, factories);
  assert.throws(() => resolve({}), /did not resolve to a provider/);
  assert.throws(() => resolve({ model: "unknown" }), /did not resolve to a provider/);
});

test("an unknown provider name throws", () => {
  const { factories } = recorder();
  assert.throws(() => buildRunnerResolver(CONFIG, factories)({ provider: "ghost" }), /unknown provider "ghost"/);
});

test("runners are cached per provider:model", () => {
  const { factories, forProviderCalls } = recorder();
  const resolve = buildRunnerResolver(CONFIG, factories);
  resolve({ provider: "claude-smart" });
  resolve({ provider: "claude-smart" });
  resolve({ provider: "claude-smart", model: "other" });
  assert.equal(forProviderCalls.length, 2); // 2 distinct (provider,model) keys, second call reused
});

test("runtime dispatches each agent through its resolved runner; cacheKey separates providers", async () => {
  const calls: { runner: string; prompt: string }[] = [];
  const make = (tag: string): WorkflowAgentRunner => ({
    async run(call) {
      calls.push({ runner: tag, prompt: call.prompt });
      return `${tag}:${call.prompt}`;
    },
  });
  const codexRunner = make("codex");
  const claudeRunner = make("claude");

  const journal = new InMemoryWorkflowJournal();
  const result = await runWorkflow(
    `export const meta = { name: 'route', description: 'route demo' }
const a = await agent('same', { provider: 'codex' })
const b = await agent('same', { provider: 'claude' })
return { a, b }
`,
    {
      runner: (options) => (options.provider === "claude" ? claudeRunner : codexRunner),
      journal,
    },
  );

  assert.deepEqual(result.result, { a: "codex:same", b: "claude:same" });
  // Same prompt, different provider → two real runs (no cross-provider cache hit).
  assert.equal(result.cacheHits, 0);
  assert.deepEqual(calls, [
    { runner: "codex", prompt: "same" },
    { runner: "claude", prompt: "same" },
  ]);
});

test("an unknown provider hard-fails the run (not a null agent result)", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'boom', description: 'boom' }
return await agent('x', { provider: 'ghost' })
`,
      {
        runner: () => {
          throw new Error("unknown provider \"ghost\"");
        },
      },
    ),
    /unknown provider "ghost"/,
  );
});
