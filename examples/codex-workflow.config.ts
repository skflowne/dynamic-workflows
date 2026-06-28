// Example provider config. Copy to your project root (or pass with --config) to route individual
// agent() calls to different backends/models. Secrets stay out of this file: pi providers reference
// a credential ENV VAR NAME via `apiKeyEnv`; the value is read at runner-build time and never stored.
//
//   codex-workflow run examples/providers-demo.js --config examples/codex-workflow.config.ts
//
// In a workflow, pick a provider per call:
//   await agent(prompt, { provider: 'claude-smart' })   // by name
//   await agent(prompt, { model: 'claude-opus-4-8' })    // by model → its provider
//   await agent(prompt)                                  // → config.default (here: codex-default)

export default {
  providers: {
    'codex-default': {
      backend: 'codex',
      model: 'gpt-5-codex',
      reasoning: 'high', // codex reasoning effort: minimal | low | medium | high | xhigh
    },

    // A cheap/fast classifier: terser instructions, no web search, no network.
    'codex-fast': {
      backend: 'codex',
      model: 'gpt-5-codex',
      reasoning: 'low',
      baseInstructions: 'Answer tersely. Do not explain unless asked.',
      webSearch: false,
      networkAccess: false,
    },

    // Claude via the pi backend talking to an Anthropic-compatible endpoint.
    'claude-smart': {
      backend: 'pi',
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
      api: 'anthropic-messages',
      model: 'claude-opus-4-8',
      models: ['claude-opus-latest'], // extra ids that route here via agent({model})
      apiKeyEnv: 'ANTHROPIC_API_KEY', // env var NAME — never the key itself
      thinking: 'high', // pi's reasoning-effort knob
      contextFiles: true, // load AGENTS.md/CLAUDE.md for this provider
    },

    // args is a raw escape hatch: any extra gemini/pi CLI flag we haven't modeled.
    'gemini-pro': { backend: 'gemini', model: 'gemini-2.5-pro', args: ['--verbosity', 'low'] },
  },

  // Used when an agent specifies neither a provider nor a model that routes.
  default: 'codex-default',
}
