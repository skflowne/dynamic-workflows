export const meta = {
  name: 'nested-demo',
  description: 'Runs the hello workflow as a nested step, then summarizes its greetings.',
  whenToUse: 'Demonstrates the one-level workflow() nesting primitive.',
  phases: [{ title: 'Delegate' }, { title: 'Summarize' }],
}

phase('Delegate')
const hello = await workflow('hello', { name: (args && args.name) || 'team' })

phase('Summarize')
const summary = await agent('Summarize these greetings into one friendly sentence: ' + JSON.stringify(hello.greetings), {
  label: 'summarize',
})

return { hello, summary }
