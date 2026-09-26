import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { HttpError, input, eventFromRow, visitFromModel, planFromModel, commandKey } from './family-logic.js';

const COOKIE = 'hc_session';
const MODEL_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
const MODEL = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
const GLOBAL_DAILY_LIMIT = 100;
const SESSION_DAILY_LIMIT = 8;

const visitPrompt = 'Extract one dinner visit from the note. Return only a JSON object shaped {"person":"...","time":"HH:MM","timeEvidence":"...","restrictions":["...","..."]}. restrictions MUST be an array of individual food or diet terms copied verbatim from the note, without words such as "cannot have". Copy person and timeEvidence verbatim. For an hour without AM or PM, interpret 1–11 as evening for this dinner visit. If any required detail is missing, use null rather than inventing it.';
const planPrompt = 'You plan one family dinner. Return only JSON with intent (dinner or unrelated), eventId, time, restrictions, meal, ingredients, and confirmations. If the request is unrelated to dinner, return {"intent":"unrelated"}. Choose an event from the calendar. Echo its time and restrictions exactly. Use its dietary notes as hard constraints; do not include a restricted ingredient. Give a specific meal and 3–8 distinct grocery ingredients, including ingredients already on the list so the app can subtract them. Suggest a different sensible meal when the visit or restriction changes. Do not claim a meal is medically safe. confirmations is an array of short things the person should check.';

function query(db, sql, ...args) {
  return db.prepare(sql).bind(...args);
}

async function rows(db, sql, ...args) {
  return (await query(db, sql, ...args).all()).results;
}

function cookieValue(request) {
  const match = request.headers.get('cookie')?.match(/(?:^|;\s*)hc_session=([0-9a-f-]{36})(?:;|$)/i);
  return match?.[1] ?? null;
}

async function session(request, env) {
  const candidate = cookieValue(request);
  if (candidate && await query(env.HOME_DB, 'SELECT id FROM sessions WHERE id = ?', candidate).first()) {
    return { id: candidate, setCookie: null };
  }
  const id = crypto.randomUUID();
  await query(env.HOME_DB, 'INSERT INTO sessions (id) VALUES (?)', id).run();
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return { id, setCookie: `${COOKIE}=${id}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax${secure}` };
}

function memoryContext(sessionId, household, date) {
  return `home-continuity:${sessionId}:${household}:${date}`;
}

async function withMcp(env, run) {
  if (!env.CONTINUITY_MCP_URL || !env.CORE_SHARED_SECRET) throw new Error('Continuity Core connection is not configured.');
  const client = new Client({ name: 'home-continuity', version: '0.2.0' });
  const transport = new StreamableHTTPClientTransport(new URL(env.CONTINUITY_MCP_URL), {
    authProvider: { token: async () => env.CORE_SHARED_SECRET }
  });
  const started = performance.now();
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);
    for (const name of ['remember_commitment', 'recall_commitments', 'resume_commitment']) {
      if (!names.includes(name)) throw new Error(`Continuity Core is missing ${name}.`);
    }
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      if (response.isError) {
        const detail = response.content?.filter(part => part.type === 'text').map(part => part.text).join(' ') || 'unknown error';
        throw new Error(`${name} failed: ${detail}`);
      }
      if (!response.structuredContent) throw new Error(`${name} returned no structured result.`);
      return response.structuredContent;
    };
    const value = await run(call);
    return { value, mcp: {
      protocolVersion: client.getNegotiatedProtocolVersion(),
      server: client.getServerVersion(),
      tools: names,
      elapsedMs: Math.round(performance.now() - started)
    } };
  } finally {
    await client.close();
  }
}

async function chargeModelCall(env, sessionId) {
  const day = new Date().toISOString().slice(0, 10);
  const globalKey = `global:${day}`;
  const sessionKey = `session:${sessionId}:${day}`;
  const upsert = 'INSERT INTO model_quota (quota_key, used, cap) VALUES (?, 1, ?) ON CONFLICT(quota_key) DO UPDATE SET used = used + 1';
  try {
    await env.HOME_DB.batch([
      query(env.HOME_DB, upsert, globalKey, GLOBAL_DAILY_LIMIT),
      query(env.HOME_DB, upsert, sessionKey, SESSION_DAILY_LIMIT)
    ]);
  } catch (error) {
    const global = await query(env.HOME_DB, 'SELECT used FROM model_quota WHERE quota_key = ?', globalKey).first();
    const personal = await query(env.HOME_DB, 'SELECT used FROM model_quota WHERE quota_key = ?', sessionKey).first();
    if ((global?.used ?? 0) >= GLOBAL_DAILY_LIMIT) throw new HttpError(429, 'The daily demo limit has been reached. Try again tomorrow.');
    if ((personal?.used ?? 0) >= SESSION_DAILY_LIMIT) throw new HttpError(429, 'This session has reached its daily demo limit. Try again tomorrow.');
    throw error;
  }
}

async function askNemotron(env, sessionId, messages, maxTokens) {
  if (!env.NEMOTRON_API_KEY) throw new Error('Nemotron is not configured.');
  await chargeModelCall(env, sessionId);
  const started = performance.now();
  const response = await fetch(MODEL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NEMOTRON_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, response_format: { type: 'json_object' }, temperature: 0, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(90_000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Nemotron HTTP ${response.status} ${response.statusText}: ${raw}`);
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error(`Nemotron returned invalid HTTP JSON: ${raw}`); }
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error(`Nemotron returned no answer text: ${raw}`);
  let value;
  try { value = JSON.parse(content); } catch { throw new Error(`Nemotron returned invalid plan JSON: ${content}`); }
  return { value, response: {
    id: result.id ?? null,
    model: result.model ?? MODEL,
    rawContent: content,
    tokens: {
      input: result.usage?.prompt_tokens ?? null,
      output: result.usage?.completion_tokens ?? null,
      total: result.usage?.total_tokens ?? null
    },
    estimatedCostUsd: result.usage?.estimated_cost ?? null,
    elapsedMs: Math.round(performance.now() - started)
  } };
}

async function findEvents(db, sessionId, household, date) {
  return (await rows(db, 'SELECT * FROM calendar_events WHERE session_id = ? AND household = ? AND date = ? ORDER BY id', sessionId, household, date)).map(eventFromRow);
}

async function findItems(db, sessionId, household, date) {
  return rows(db, 'SELECT item, source_event_id, created_at FROM shopping_items WHERE session_id = ? AND household = ? AND date = ? ORDER BY id', sessionId, household, date);
}

async function remember(env, sessionId, body) {
  const { household, date, utterance } = input(body);
  if (!utterance) throw new HttpError(422, 'Tell me who is visiting, when, and what they cannot eat.');
  const model = await askNemotron(env, sessionId, [
    { role: 'system', content: visitPrompt },
    { role: 'user', content: JSON.stringify({ date, note: utterance }) }
  ], 500);
  const visit = visitFromModel(model.value, utterance);
  const events = await findEvents(env.HOME_DB, sessionId, household, date);
  if (events.length >= 8) throw new HttpError(422, 'This date already has eight dinner visits.');
  if (events.some(event => event.person === visit.person)) throw new HttpError(409, `${visit.person}'s dinner is already on the calendar for ${date}.`);
  const context = memoryContext(sessionId, household, date);
  const commitment = `${visit.person} visits on ${date} at ${visit.time}. Dietary notes: ${visit.restrictions.join(', ')}. Original note: ${utterance}`;
  const { value: saved, mcp } = await withMcp(env, call => call('remember_commitment', {
    context,
    commitment,
    next_action: `Plan dinner for ${visit.person} with these dietary notes and update the family shopping list.`,
    done_when: 'The family calendar and shopping list show the dinner plan.'
  }));
  if (!Number.isInteger(saved.id) || saved.context !== context) throw new Error('Continuity Core returned an incomplete memory.');
  try {
    await query(env.HOME_DB, `INSERT INTO calendar_events
      (session_id, household, date, time, title, dietary_note, source_utterance, memory_id, person, restrictions_json, time_assumed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId, household, date, visit.time, `Dinner with ${visit.person}`, visit.restrictions.join(', '), utterance,
      saved.id, visit.person, JSON.stringify(visit.restrictions), Number(visit.timeNeedsConfirmation)).run();
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) throw new HttpError(409, 'This dinner is already on the calendar.');
    throw error;
  }
  const event = (await findEvents(env.HOME_DB, sessionId, household, date)).find(item => item.memoryId === saved.id);
  if (!event) throw new Error('The saved visit could not be read back.');
  return {
    status: 'saved',
    memory: { id: saved.id, context: saved.context, commitment: saved.commitment },
    calendar: event,
    model: model.response,
    confirmations: event.timeNeedsConfirmation ? [`Confirm that ${model.value.timeEvidence} means ${event.time}.`] : [],
    mcp
  };
}

async function pickUp(env, sessionId, body) {
  const { household, date, utterance } = input(body);
  if (!utterance) throw new HttpError(422, 'Tell me which dinner to pick up.');
  const db = env.HOME_DB;
  const events = await findEvents(db, sessionId, household, date);
  if (!events.length) throw new HttpError(409, 'There is no saved dinner on the calendar for this date.');
  const beforeModel = await findItems(db, sessionId, household, date);
  const key = commandKey(utterance);
  const findPlanSql = 'SELECT * FROM dinner_plans WHERE session_id = ? AND household = ? AND date = ? AND command_key = ?';
  const cached = await query(db, findPlanSql, sessionId, household, date, key).first();
  const context = memoryContext(sessionId, household, date);
  const { value, mcp } = await withMcp(env, async call => {
    const recalled = await call('recall_commitments', { context });
    if (!Array.isArray(recalled.commitments)) throw new Error('Continuity Core returned no commitment list.');
    for (const event of events) {
      if (!recalled.commitments.some(entry => entry.id === event.memoryId)) {
        throw new HttpError(409, `The calendar entry for ${event.person} has no matching saved memory.`);
      }
    }
    let plan;
    let modelResponse;
    if (cached) {
      plan = planFromModel(JSON.parse(cached.plan_json), events, utterance);
      modelResponse = JSON.parse(cached.model_response_json);
    } else {
      const model = await askNemotron(env, sessionId, [
        { role: 'system', content: planPrompt },
        { role: 'user', content: JSON.stringify({ request: utterance, date, calendar: events, remembered: recalled.commitments, shoppingList: beforeModel.map(item => item.item) }) }
      ], 950);
      plan = planFromModel(model.value, events, utterance);
      modelResponse = model.response;
    }
    const event = events.find(item => item.id === plan.eventId);
    const resumed = await call('resume_commitment', { id: event.memoryId });
    if (resumed.id !== event.memoryId || resumed.context !== context || !resumed.commitment?.includes(event.sourceUtterance)) {
      throw new Error('The saved memory does not match this calendar visit.');
    }
    return { plan, modelResponse, event, resumed, recalled: recalled.commitments.find(entry => entry.id === event.memoryId) };
  });
  const before = await findItems(db, sessionId, household, date);
  if (!cached) {
    await query(db, `INSERT OR IGNORE INTO dinner_plans
      (session_id, household, date, command_key, event_id, plan_json, model_response_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sessionId, household, date, key, value.event.id, JSON.stringify(value.plan), JSON.stringify(value.modelResponse)).run();
  }
  const stored = await query(db, findPlanSql, sessionId, household, date, key).first();
  if (!stored) throw new Error('The dinner plan could not be read back.');
  const persistedPlan = JSON.parse(stored.plan_json);
  const insertions = await db.batch(persistedPlan.ingredients.map(item => query(db,
    'INSERT OR IGNORE INTO shopping_items (session_id, household, date, item, source_event_id) VALUES (?, ?, ?, ?, ?)',
    sessionId, household, date, item, stored.event_id)));
  const added = persistedPlan.ingredients.filter((_, index) => insertions[index].meta.changes === 1);
  const event = events.find(item => item.id === stored.event_id);
  if (!event) throw new Error('The stored plan has no matching calendar visit.');
  const confirmations = [...persistedPlan.confirmations, `Check ingredient labels against ${event.person}'s dietary notes before serving.`];
  if (event.timeNeedsConfirmation) confirmations.push(`Confirm that the visit is at ${event.time}.`);
  return {
    status: 'completed',
    card: {
      input: utterance,
      title: event.title,
      time: `${date} ${event.time}`,
      dietaryNotes: event.restrictions,
      meal: persistedPlan.meal,
      ingredients: persistedPlan.ingredients,
      addedItems: added,
      confirmations
    },
    sources: { remembered: value.recalled, resumed: value.resumed, calendar: event },
    shopping: { before, added, after: await findItems(db, sessionId, household, date) },
    model: { ...JSON.parse(stored.model_response_json), reused: Boolean(cached) },
    mcp
  };
}

async function state(env, sessionId, params) {
  const { household, date } = input({ household: params.get('household'), date: params.get('date') });
  const calendar = await findEvents(env.HOME_DB, sessionId, household, date);
  const latest = await query(env.HOME_DB,
    'SELECT * FROM dinner_plans WHERE session_id = ? AND household = ? AND date = ? ORDER BY id DESC LIMIT 1',
    sessionId, household, date).first();
  return {
    calendar,
    shopping: await findItems(env.HOME_DB, sessionId, household, date),
    latestPlan: latest ? {
      ...JSON.parse(latest.plan_json),
      event: calendar.find(event => event.id === latest.event_id),
      model: JSON.parse(latest.model_response_json),
      createdAt: latest.created_at
    } : null
  };
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Send application/json.');
  const body = await request.text();
  if (body.length > 16_384) throw new HttpError(413, 'Request body is too large.');
  try { return JSON.parse(body); } catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
}

function json(status, value, started) {
  return Response.json({ ...value, elapsedMs: Math.round(performance.now() - started) }, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}

export default {
  async fetch(request, env) {
    const started = performance.now();
    const url = new URL(request.url);
    let visitor;
    try {
      if (!['/', '/app.css', '/app.js', '/api/remember', '/api/pick-up-dinner', '/api/state'].includes(url.pathname)) {
        throw new HttpError(404, 'Route not found.');
      }
      visitor = await session(request, env);
      let response;
      if (request.method === 'GET' && ['/', '/app.css', '/app.js'].includes(url.pathname)) {
        const assetUrl = new URL(url.pathname === '/' ? '/index.html' : url.pathname, request.url);
        const asset = await env.ASSETS.fetch(assetUrl);
        if (!asset.ok) throw new Error(`Page asset failed: HTTP ${asset.status}.`);
        response = new Response(asset.body, asset);
        response.headers.set('cache-control', 'no-store');
        response.headers.set('x-content-type-options', 'nosniff');
        response.headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:");
      } else {
        let result;
        if (request.method === 'POST' && url.pathname === '/api/remember') result = await remember(env, visitor.id, await readJson(request));
        else if (request.method === 'POST' && url.pathname === '/api/pick-up-dinner') result = await pickUp(env, visitor.id, await readJson(request));
        else if (request.method === 'GET' && url.pathname === '/api/state') result = await state(env, visitor.id, url.searchParams);
        else throw new HttpError(404, 'Route not found.');
        response = json(200, result, started);
      }
      if (visitor.setCookie) response.headers.set('set-cookie', visitor.setCookie);
      return response;
    } catch (error) {
      console.error(error);
      const response = json(error.status ?? 500, { status: 'error', error: error.message }, started);
      if (visitor?.setCookie) response.headers.set('set-cookie', visitor.setCookie);
      return response;
    }
  }
};
