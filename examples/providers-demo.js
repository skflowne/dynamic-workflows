export const meta = {
  name: 'providers-demo',
  description: 'Route each agent() to a different configured provider (needs --config).',
  whenToUse: 'Demo of per-agent provider/model routing via a provider config.',
  phases: [{ title: 'Fan-out' }, { title: 'Synthesize' }],
}

// Pair with examples/codex-workflow.config.ts:
//   codex-workflow run examples/providers-demo.js --config examples/codex-workflow.config.ts
const topic = (args && args.topic) || 'the tradeoffs of monorepos'

phase('Fan-out')
const takes = await parallel([
  // by provider name
  () => agent('Give a one-paragraph take on ' + topic + '.', { label: 'smart', provider: 'claude-smart' }),
  () => agent('Give a skeptical one-paragraph take on ' + topic + '.', { label: 'fast', provider: 'codex-fast' }),
  // by model id → its provider (falls back to config.default if the model is unknown)
  () => agent('List 3 risks of ' + topic + '.', { label: 'by-model', model: 'gemini-2.5-pro' }),
])

phase('Synthesize')
// No provider/model → config.default provider.
const summary = await agent('Synthesize these takes into 3 bullets:\n' + JSON.stringify(takes), {
  label: 'synthesize',
})

return { topic, takes, summary }
