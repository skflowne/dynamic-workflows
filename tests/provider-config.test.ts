import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildModelIndex,
  discoverProviderConfig,
  loadProviderConfig,
  resolveProviderName,
  validateProvidersConfig,
} from "../src/index.js";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-providers-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loads a TS provider config (transpiled), reading process.env", async () => {
  await withDir(async (dir) => {
    process.env.CW_TEST_BASE_URL = "https://example.test";
    const file = path.join(dir, "codex-workflow.config.ts");
    await writeFile(
      file,
      `interface X { backend: string }
export default {
  providers: {
    'codex-default': { backend: 'codex', model: 'gpt-5-codex' },
    'claude-smart': { backend: 'pi', baseUrl: process.env.CW_TEST_BASE_URL, api: 'anthropic-messages', model: 'claude-opus-4-8', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  },
  default: 'codex-default',
}
`,
      "utf8",
    );
    const loaded = await loadProviderConfig(file);
    assert.equal(loaded.path, file);
    assert.equal(loaded.config.providers["claude-smart"]?.baseUrl, "https://example.test");
    assert.equal(loaded.config.providers["claude-smart"]?.backend, "pi");
    assert.equal(loaded.config.default, "codex-default");
    assert.equal(resolveProviderName(loaded.config, "claude-smart"), "claude-smart");
    assert.throws(() => resolveProviderName(loaded.config, "ghost"), /unknown provider "ghost"/);
    assert.match(loaded.hash, /^[0-9a-f]{16}$/);
    delete process.env.CW_TEST_BASE_URL;
  });
});

test("loads a JS (.mjs) provider config from its file URL", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "providers.config.mjs");
    await writeFile(file, `export default { providers: { p: { backend: 'gemini', model: 'gemini-2.5-pro' } } }\n`, "utf8");
    const loaded = await loadProviderConfig(file);
    assert.equal(loaded.config.providers.p?.model, "gemini-2.5-pro");
  });
});

test("discoverProviderConfig prefers cwd, then errors on a missing explicit path", async () => {
  await withDir(async (dir) => {
    const data = path.join(dir, "data");
    await writeFile(path.join(dir, "codex-workflow.config.ts"), "export default { providers: { a: { backend: 'codex' } } }\n", "utf8");
    assert.equal(await discoverProviderConfig(dir, data), path.join(dir, "codex-workflow.config.ts"));
    await assert.rejects(discoverProviderConfig(dir, data, "nope.ts"), /--config file not found/);
  });
});

test("validation rejects cross-backend fields, unknown fields, and bad backends", () => {
  assert.throws(
    () => validateProvidersConfig({ providers: { x: { backend: "codex", baseUrl: "http://x" } } }, "t"),
    /field "baseUrl" is only valid for backend "pi"/,
  );
  assert.throws(
    () => validateProvidersConfig({ providers: { x: { backend: "pi", sandbox: "read-only" } } }, "t"),
    /field "sandbox" is only valid for backend "codex"/,
  );
  assert.throws(() => validateProvidersConfig({ providers: { x: { backend: "codex", wat: 1 } } }, "t"), /unknown field "wat"/);
  assert.throws(() => validateProvidersConfig({ providers: { x: { backend: "nope" } } }, "t"), /needs backend/);
  assert.throws(() => validateProvidersConfig({ providers: {} }, "t"), /at least one provider/);
});

test("validation catches a dangling default", () => {
  assert.throws(() => validateProvidersConfig({ providers: { a: { backend: "codex" } }, default: "ghost" }, "t"), /unknown provider "ghost"/);
});

test("accepts the runner-injectable knobs (baseInstructions/args/web-search/yolo/approve)", () => {
  const config = validateProvidersConfig(
    {
      providers: {
        c: { backend: "codex", baseInstructions: "be terse", webSearch: false, networkAccess: false, webSearchMode: "off" },
        g: { backend: "gemini", yolo: false, args: ["--foo", "bar"], baseInstructions: "x" },
        p: { backend: "pi", approve: false, contextFiles: true, args: ["--baz"] },
      },
    },
    "t",
  );
  assert.equal(config.providers.c?.webSearch, false);
  assert.equal(config.providers.c?.baseInstructions, "be terse");
  assert.deepEqual(config.providers.g?.args, ["--foo", "bar"]);
  assert.equal(config.providers.p?.contextFiles, true);
});

test("rejects backend-mismatched and wrong-typed knobs", () => {
  assert.throws(
    () => validateProvidersConfig({ providers: { x: { backend: "codex", yolo: true } } }, "t"),
    /field "yolo" is only valid for backend "gemini"/,
  );
  assert.throws(
    () => validateProvidersConfig({ providers: { x: { backend: "pi", webSearch: true } } }, "t"),
    /field "webSearch" is only valid for backend "codex"/,
  );
  // `args` belongs to both gemini and pi → the error names both.
  assert.throws(
    () => validateProvidersConfig({ providers: { x: { backend: "codex", args: ["--x"] } } }, "t"),
    /field "args" is only valid for backend "gemini"\/"pi"/,
  );
  assert.throws(() => validateProvidersConfig({ providers: { x: { backend: "codex", webSearch: "yes" } } }, "t"), /field "webSearch" must be a boolean/);
  assert.throws(() => validateProvidersConfig({ providers: { x: { backend: "pi", args: "nope" } } }, "t"), /field "args" must be a string array/);
});

test("buildModelIndex maps each provider's model and extra models", () => {
  const config = validateProvidersConfig(
    {
      providers: {
        smart: { backend: "pi", model: "claude-opus-4-8", models: ["claude-opus-latest"] },
        codex: { backend: "codex", model: "gpt-5-codex" },
      },
    },
    "t",
  );
  const index = buildModelIndex(config);
  assert.deepEqual(index.get("claude-opus-4-8"), ["smart"]);
  assert.deepEqual(index.get("claude-opus-latest"), ["smart"]);
  assert.deepEqual(index.get("gpt-5-codex"), ["codex"]);
  assert.equal(index.get("unknown"), undefined);
});
