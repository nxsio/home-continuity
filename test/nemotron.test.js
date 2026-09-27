import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NEMOTRON_API_KEY = 'test-only';
const { askNemotron } = await import('../src/nemotron.js');

test('dinner extraction disables model thinking and accepts structured JSON', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"person":"Aunt Inez","time":"18:15","timeEvidence":"6:15 PM","restrictions":["sesame"]}' } }] }), { status: 200 });
  };
  try {
    const result = await askNemotron([{ role: 'user', content: 'Aunt Inez visits at 6:15 PM.' }], 420);
    assert.equal(result.value.person, 'Aunt Inez');
    assert.deepEqual(result.value.restrictions, ['sesame']);
  } finally { globalThis.fetch = original; }
});

test('unusable model text is not returned in an application error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'We need to extract the visit from the note...' } }] }), { status: 200 });
  try {
    await assert.rejects(askNemotron([{ role: 'user', content: 'Aunt Inez visits at 6:15 PM.' }], 420), error =>
      error.message.includes('unusable result') && !error.message.includes('We need to extract'));
  } finally { globalThis.fetch = original; }
});
