export const meta = {
  name: 'live-check',
  description: 'Verify the live Codex path: plain text, structured (schema) output, and parallel.',
  phases: [{ title: 'Probe' }],
}

phase('Probe')

// 1) Plain text agent — returns the final response verbatim.
const plain = await agent('Reply with exactly one word and nothing else: pong', { label: 'ping' })

// 2) Structured output — Codex must return JSON matching the schema; the runtime parses + validates it.
const structured = await agent('Add 19 and 23. Return only the result as structured output.', {
  label: 'sum',
  schema: {
    type: 'object',
    required: ['sum'],
    additionalProperties: false,
    properties: { sum: { type: 'number' } },
  },
})

// 3) Parallel fan-out — two independent agents at once.
const caps = await parallel(
  ['codex', 'workflow'].map((w) => () =>
    agent('Uppercase this single word and reply with only the result: ' + w, { label: 'upper:' + w }),
  ),
)

return { plain, structured, caps }
