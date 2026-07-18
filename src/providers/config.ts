import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { WorkflowInputError } from "../errors.js";

/**
 * Provider config: a TS/JS file that `export default`s a {@link ProvidersConfig}. It names a set of
 * agent providers (each = a backend + model + endpoint + credential-env) so a workflow can route a
 * single `agent()` call to a specific one via `agent({provider})` / `agent({model})`. Loaded by the
 * CLI; the file itself is plain TS/JS evaluated in this process, so `process.env` works inside it.
 *
 * Secrets never live in the config: pi providers reference a credential **env var name** via
 * `apiKeyEnv`; the value is read from `process.env` at runner-build time and never persisted.
 */
export type ProviderBackend = "codex" | "gemini" | "pi";

export interface ProviderDef {
  backend: ProviderBackend;
  /** Concrete/default model sent to the backend for this provider. */
  model?: string;
  /** Extra model ids this provider serves — feeds the `agent({model})` → provider routing index. */
  models?: string[];
  /** Per-agent total-duration timeout (ms); 0 disables. */
  agentTimeoutMs?: number;
  /** Extra system instructions prepended to every agent prompt for this provider (all backends). */
  baseInstructions?: string;
  // codex-only
  sandbox?: string;
  approval?: string;
  reasoning?: string;
  /** Allow the agent's built-in web search (codex). Default true. */
  webSearch?: boolean;
  /** Allow network access (codex). Default true. */
  networkAccess?: boolean;
  /** Codex web-search mode. */
  webSearchMode?: string;
  // gemini-only
  geminiCommand?: string;
  /** Auto-accept tool calls — gemini `-y` (default true). */
  yolo?: boolean;
  // pi-only
  baseUrl?: string;
  api?: string;
  /** pi backend provider id (pi `--provider`, e.g. openai/anthropic). Distinct from this config's provider names. */
  piProvider?: string;
  /** Name of the env var holding the API key for a custom pi endpoint. The key value is never stored. */
  apiKeyEnv?: string;
  thinking?: string;
  tools?: string[];
  excludeTools?: string[];
  noTools?: boolean;
  /** Trust project-local files — pi `--approve` (default true). */
  approve?: boolean;
  /** Load AGENTS.md/CLAUDE.md context — pi (default false). */
  contextFiles?: boolean;
  piCommand?: string;
  // gemini + pi: raw extra CLI args inserted before the generated flags (escape hatch for un-modeled flags).
  args?: string[];
}

export interface ProvidersConfig {
  providers: Record<string, ProviderDef>;
  /** Provider used when an agent specifies neither a provider nor a model that routes. */
  default?: string;
}

export interface LoadedProviderConfig {
  config: ProvidersConfig;
  /** Absolute path the config was loaded from. */
  path: string;
  /** Short content hash (secret-free) — recorded with a run so resume can detect config drift. */
  hash: string;
}

const BACKENDS: ProviderBackend[] = ["codex", "gemini", "pi"];
/** Single source of truth for enum-valued provider-def fields; the CLI imports these instead of redeclaring them. */
export const PI_API_SHAPES = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
export const APPROVAL_MODES = ["never", "on-request", "on-failure", "untrusted"];
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
export const WEB_SEARCH_MODES = ["disabled", "cached", "live"];
const COMMON_FIELDS = ["backend", "model", "models", "agentTimeoutMs", "baseInstructions"];
const BACKEND_FIELDS: Record<ProviderBackend, string[]> = {
  codex: ["sandbox", "approval", "reasoning", "webSearch", "networkAccess", "webSearchMode"],
  gemini: ["geminiCommand", "yolo", "args"],
  pi: ["baseUrl", "api", "piProvider", "apiKeyEnv", "thinking", "tools", "excludeTools", "noTools", "approve", "contextFiles", "piCommand", "args"],
};
const STRING_FIELDS = [
  "model",
  "baseInstructions",
  "sandbox",
  "approval",
  "reasoning",
  "webSearchMode",
  "geminiCommand",
  "baseUrl",
  "api",
  "piProvider",
  "apiKeyEnv",
  "thinking",
  "piCommand",
];
const STRING_ARRAY_FIELDS = ["models", "tools", "excludeTools", "args"];
const BOOLEAN_FIELDS = ["noTools", "webSearch", "networkAccess", "yolo", "approve", "contextFiles"];

const CONFIG_BASENAMES = [
  "codex-workflow.config.ts",
  "codex-workflow.config.mts",
  "codex-workflow.config.js",
  "codex-workflow.config.mjs",
];

/**
 * Resolve which provider config to load: an explicit `--config` path wins; otherwise look for a
 * `codex-workflow.config.{ts,mts,js,mjs}` in `cwd`, then in the global data dir. Returns undefined
 * when none exists (the CLI then runs in single-backend / anonymous mode).
 */
export async function discoverProviderConfig(
  cwd: string,
  dataDir: string,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) {
    const abs = path.resolve(cwd, explicit);
    if (!(await isFile(abs))) throw new WorkflowInputError(`--config file not found: ${explicit}`);
    return abs;
  }
  for (const dir of [cwd, dataDir]) {
    for (const base of CONFIG_BASENAMES) {
      const abs = path.join(dir, base);
      if (await isFile(abs)) return abs;
    }
  }
  return undefined;
}

/** Load + validate a provider config file (TS or JS). */
export async function loadProviderConfig(absPath: string): Promise<LoadedProviderConfig> {
  let mod: Record<string, unknown>;
  try {
    mod = (await importConfigModule(absPath)) as Record<string, unknown>;
  } catch (error) {
    throw new WorkflowInputError(
      `failed to load provider config ${absPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const raw = mod.default ?? mod.config;
  if (raw === undefined || raw === null) {
    throw new WorkflowInputError(`provider config ${absPath} must \`export default\` (or export \`config\`) an object`);
  }
  const config = validateProvidersConfig(raw, absPath);
  const hash = createHash("sha256").update(stableJson(config)).digest("hex").slice(0, 16);
  return { config, path: absPath, hash };
}

/** Imports a config module: `.js/.mjs` from its file URL; `.ts/.mts` transpiled to an inline data: URL. */
async function importConfigModule(absPath: string): Promise<unknown> {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs") {
    return import(pathToFileURL(absPath).href);
  }
  // typescript is already a runtime dependency (used by the parser); reuse it instead of adding a loader.
  const source = await readFile(absPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: absPath,
  });
  // A data: URL module still runs in this process, so `process.env` works; relative imports do not.
  const url = `data:text/javascript;base64,${Buffer.from(outputText, "utf8").toString("base64")}`;
  return import(url);
}

export function validateProvidersConfig(raw: unknown, source: string): ProvidersConfig {
  const where = `provider config ${source}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkflowInputError(`${where}: default export must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "providers" && key !== "default") {
      throw new WorkflowInputError(`${where}: unknown top-level field "${key}" (allowed: providers, default)`);
    }
  }
  const providersRaw = obj.providers;
  if (typeof providersRaw !== "object" || providersRaw === null || Array.isArray(providersRaw)) {
    throw new WorkflowInputError(`${where}: \`providers\` must be an object of name → definition`);
  }
  const names = Object.keys(providersRaw as Record<string, unknown>);
  if (names.length === 0) throw new WorkflowInputError(`${where}: \`providers\` must define at least one provider`);

  const providers: Record<string, ProviderDef> = {};
  for (const name of names) {
    providers[name] = validateProviderDef(name, (providersRaw as Record<string, unknown>)[name], where);
  }

  const config: ProvidersConfig = { providers };

  if (obj.default !== undefined) {
    if (typeof obj.default !== "string") throw new WorkflowInputError(`${where}: \`default\` must be a string`);
    config.default = obj.default;
  }

  // Resolve the default now so a dangling target fails at load, not mid-run.
  if (config.default) resolveProviderName(config, config.default, source);

  return config;
}

function validateProviderDef(name: string, raw: unknown, where: string): ProviderDef {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkflowInputError(`${where}: provider "${name}" must be an object`);
  }
  const def = raw as Record<string, unknown>;
  const backend = def.backend;
  if (typeof backend !== "string" || !BACKENDS.includes(backend as ProviderBackend)) {
    throw new WorkflowInputError(`${where}: provider "${name}" needs backend: ${BACKENDS.join(" | ")} (got ${JSON.stringify(backend)})`);
  }
  const allowed = new Set([...COMMON_FIELDS, ...BACKEND_FIELDS[backend as ProviderBackend]]);
  for (const key of Object.keys(def)) {
    if (allowed.has(key)) continue;
    const owners = (Object.entries(BACKEND_FIELDS) as [ProviderBackend, string[]][])
      .filter(([, fields]) => fields.includes(key))
      .map(([b]) => b);
    if (owners.length) {
      throw new WorkflowInputError(`${where}: provider "${name}" field "${key}" is only valid for backend ${owners.map((b) => `"${b}"`).join("/")}, not "${backend}"`);
    }
    throw new WorkflowInputError(`${where}: provider "${name}" has unknown field "${key}"`);
  }
  for (const key of STRING_FIELDS) {
    if (def[key] !== undefined && typeof def[key] !== "string") {
      throw new WorkflowInputError(`${where}: provider "${name}" field "${key}" must be a string`);
    }
  }
  for (const key of STRING_ARRAY_FIELDS) {
    const value = def[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw new WorkflowInputError(`${where}: provider "${name}" field "${key}" must be a string array`);
    }
  }
  for (const key of BOOLEAN_FIELDS) {
    if (def[key] !== undefined && typeof def[key] !== "boolean") {
      throw new WorkflowInputError(`${where}: provider "${name}" field "${key}" must be a boolean`);
    }
  }
  if (def.agentTimeoutMs !== undefined && (typeof def.agentTimeoutMs !== "number" || !Number.isFinite(def.agentTimeoutMs) || def.agentTimeoutMs < 0)) {
    throw new WorkflowInputError(`${where}: provider "${name}" field "agentTimeoutMs" must be a non-negative number`);
  }
  if (def.api !== undefined && !PI_API_SHAPES.includes(def.api as string)) {
    throw new WorkflowInputError(`${where}: provider "${name}" field "api" must be one of: ${PI_API_SHAPES.join(", ")}`);
  }
  if (backend === "codex") {
    assertEnumField(where, name, "sandbox", def.sandbox, SANDBOX_MODES);
    assertEnumField(where, name, "approval", def.approval, APPROVAL_MODES);
    assertEnumField(where, name, "reasoning", def.reasoning, REASONING_EFFORTS);
    assertEnumField(where, name, "webSearchMode", def.webSearchMode, WEB_SEARCH_MODES);
  } else if (backend === "pi") {
    assertEnumField(where, name, "thinking", def.thinking, REASONING_EFFORTS);
    if (def.baseUrl !== undefined && !def.model) {
      throw new WorkflowInputError(`${where}: provider "${name}" with \`baseUrl\` requires \`model\` (the model id sent to the endpoint)`);
    }
  }
  return def as unknown as ProviderDef;
}

function assertEnumField(where: string, name: string, key: string, value: unknown, allowed: string[]): void {
  if (value !== undefined && !allowed.includes(value as string)) {
    throw new WorkflowInputError(`${where}: provider "${name}" field "${key}" must be one of: ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
  }
}

/** Validate that `name` is a real provider, returning it. Throws {@link WorkflowInputError} otherwise. */
export function resolveProviderName(config: ProvidersConfig, name: string, source = "provider config"): string {
  if (name in config.providers) return name;
  throw new WorkflowInputError(`provider config ${source}: unknown provider "${name}"`);
}

/** Build the `agent({model})` → provider-name(s) routing index from each provider's `model` + `models`. */
export function buildModelIndex(config: ProvidersConfig): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [name, def] of Object.entries(config.providers)) {
    const ids = [def.model, ...(def.models ?? [])].filter((id): id is string => typeof id === "string" && id.length > 0);
    for (const id of ids) {
      const list = index.get(id) ?? [];
      if (!list.includes(name)) list.push(name);
      index.set(id, list);
    }
  }
  return index;
}

/** Stable JSON for hashing (keys sorted). The config holds no secrets — apiKeyEnv is a var name. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}
