export const meta = {
  name: 'nested-demo',
  description: 'Runs the hello workflow as a nested step, then summarizes its greetings.',
  whenToUse: 'Demonstrates the one-level workflow() nesting primitive (by path).',
  phases: [{ title: 'Delegate' }, { title: 'Summarize' }],
}

// Path-only nesting: workflow() takes a path (or { scriptPath }), resolved relative to the current
// working directory — so run this from the repo root: `codex-workflow run examples/nested-demo.js`.
phase('Delegate')
const hello = await workflow('examples/hello.js', { name: (args && args.name) || 'team' })

phase('Summarize')
const summary = await agent('Summarize these greetings into one friendly sentence: ' + JSON.stringify(hello.greetings), {
  label: 'summarize',
})

return { hello, summary }
