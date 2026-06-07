export const meta = {
  name: 'hello',
  description: 'Greet someone via a couple of parallel agents and combine the results.',
  whenToUse: 'A minimal demo of agent() + parallel().',
  phases: [{ title: 'Greet' }],
}

phase('Greet')
const who = (args && args.name) || 'world'
const greetings = await parallel(
  ['English', 'Spanish'].map((lang) => () =>
    agent('Say a one-line hello to ' + who + ' in ' + lang + '. Reply with only the greeting.', {
      label: 'greet:' + lang,
    }),
  ),
)
return { who, greetings }
