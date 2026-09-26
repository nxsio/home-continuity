import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../cloudflare/worker.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const context = `home-continuity:${sessionId}:family:2030-06-12`;
const requestBody = { household: 'family', date: '2030-06-12', utterance: 'Continue dinner for Mom tonight' };
const visit = {
  id: 1, memoryId: 42, context, sourceUtterance: "Mom is coming at 7 PM and can't have peanuts",
  restrictions: ['peanuts'], time: '19:00'
};

function responseBody() {
  const plan = {
    intent: 'dinner', eventId: 1, time: '19:00', restrictions: ['peanuts'],
    meal: 'Roast chicken with rice', ingredients: ['rice', 'carrots', 'chicken'], confirmations: []
  };
  return {
    status: 'completed', plan,
    model: {
      provider: 'bedrock', model: 'amazon.nova-micro-v1:0', rawContent: JSON.stringify(plan),
      request: { date: '2030-06-12', utterance: requestBody.utterance, calendarCount: 1, rememberedCount: 1, shoppingCount: 0 },
      tokens: { input: 120, output: 75, total: 195 }
    },
    mcp: {
      protocolVersion: '2025-11-25', server: { name: 'continuity-core', version: '0.2.0' },
      calls: [{ name: 'recall_commitments', context }, { name: 'resume_commitment', id: 42 }], elapsedMs: 14
    },
    sources: {
      commitments: [{ id: 42, context, commitment: visit.sourceUtterance }],
      resumed: { id: 42, context, commitment: visit.sourceUtterance, next_step: 'Plan dinner' }
    }
  };
}

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_home.sql', import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO sessions (id) VALUES (?)').run(sessionId);
  sqlite.prepare(`INSERT INTO calendar_events
    (session_id, household, date, time, title, dietary_note, source_utterance, memory_id, person, restrictions_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sessionId, 'family', '2030-06-12', '19:00', 'Dinner with Mom', 'peanuts',
    visit.sourceUtterance, 42, 'Mom', JSON.stringify(visit.restrictions)
  );
  const adapter = {
    prepare(sql) {
      return {
        bind(...parameters) {
          const statement = sqlite.prepare(sql);
          return {
            first: async () => statement.get(...parameters) ?? null,
            all: async () => ({ results: statement.all(...parameters) }),
            run: async () => ({ meta: { changes: statement.run(...parameters).changes } })
          };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return { sqlite, adapter };
}

async function pickUp(adapter) {
  return worker.fetch(new Request('https://home-continuity.nxsio.com/api/pick-up-dinner', {
    method: 'POST', headers: { cookie: `hc_session=${sessionId}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody)
  }), {
    HOME_DB: adapter,
    AGENTCORE_RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/dinner_agent-123',
    AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret'
  });
}

test('AgentCore failure leaves the calendar and shopping list unchanged', async () => {
  const { sqlite, adapter } = database();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('access denied', { status: 403 });
  try {
    const response = await pickUp(adapter);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /AgentCore invocation failed \(HTTP 403\)/);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM shopping_items').get().count, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM dinner_plans').get().count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('signed AgentCore response goes through the existing D1 list', async () => {
  const { sqlite, adapter } = database();
  const originalFetch = globalThis.fetch;
  let invoked = false;
  globalThis.fetch = async (request) => {
    invoked = true;
    assert.match(request.url, /bedrock-agentcore\.us-east-1\.amazonaws\.com\/runtimes\/arn%3Aaws/);
    assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
    assert.equal((await request.json()).context, context);
    return Response.json(responseBody(), { headers: { 'x-amzn-requestid': 'real-request-id' } });
  };
  try {
    const response = await pickUp(adapter);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(invoked, true);
    assert.equal(result.model.provider, 'bedrock');
    assert.equal(result.model.agentCoreRequestId, 'real-request-id');
    assert.deepEqual(result.mcp.tools, ['recall_commitments', 'resume_commitment']);
    assert.equal(result.shopping.before.length, 0);
    assert.equal(result.shopping.after.length, 3);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM dinner_plans').get().count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('a fabricated MCP trace is rejected before any plan is persisted', async () => {
  const { sqlite, adapter } = database();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const result = responseBody();
    result.mcp.calls[1].id = 99;
    return Response.json(result);
  };
  try {
    const response = await pickUp(adapter);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /memory does not match/);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM shopping_items').get().count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test('the lifetime AWS cap blocks an invocation before reaching the Runtime', async () => {
  const { sqlite, adapter } = database();
  sqlite.prepare('INSERT INTO model_quota (quota_key, used, cap) VALUES (?, ?, ?)').run('aws:total', 1000, 1000);
  const originalFetch = globalThis.fetch;
  let invoked = false;
  globalThis.fetch = async () => {
    invoked = true;
    throw new Error('AgentCore should not have been called.');
  };
  try {
    const response = await pickUp(adapter);
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /AWS demo limit/);
    assert.equal(invoked, false);
    assert.equal(sqlite.prepare('SELECT count(*) AS count FROM shopping_items').get().count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
