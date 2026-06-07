export const meta = {
  name: 'complex-chain',
  description: 'Multi-step subagent orchestration: decompose -> per-item draft+refine -> synthesize.',
  phases: [{ title: 'Decompose' }, { title: 'Expand' }, { title: 'Synthesize' }],
}

const goal = (args && args.goal) || 'a command-line tool that resizes images'

// Step 1: one subagent decomposes the goal into exactly 3 components (structured handoff via schema).
phase('Decompose')
const plan = await agent(
  'Break this software goal into exactly 3 high-level components. Goal: "' + goal + '". ' +
    'Reply as structured output. Keep each component name under 6 words.',
  {
    label: 'decompose',
    schema: {
      type: 'object',
      required: ['components'],
      additionalProperties: false,
      properties: {
        components: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'string' } },
      },
    },
  },
)
log('decomposed into: ' + plan.components.join(' | '))

// Step 2: for EACH component a 2-step pipeline (describe -> risk). The risk subagent receives the
// describe subagent's output in its prompt, proving context is threaded between subagents.
phase('Expand')
const expanded = await pipeline(
  plan.components,
  (component) =>
    agent('In ONE sentence, describe the responsibility of this component: "' + component + '" for the goal: ' + goal + '.', {
      label: 'describe:' + component,
      phase: 'Expand',
    }).then((description) => ({ component, description })),
  (item) =>
    agent('Given this component description, name exactly ONE concrete failure risk in under 12 words.\nDescription: ' + item.description, {
      label: 'risk:' + item.component,
      phase: 'Expand',
    }).then((risk) => ({ ...item, risk })),
)

// Step 3: a final subagent synthesizes ALL prior subagent outputs into a verdict.
phase('Synthesize')
const summary = await agent(
  'You are given components, descriptions, and risks for the goal "' +
    goal +
    '":\n' +
    JSON.stringify(expanded, null, 2) +
    '\n\nWrite a 3-bullet implementation brief. Each bullet: the component name + the single most important action. Be terse.',
  { label: 'synthesize' },
)

return { goal, components: plan.components, expanded, summary }
