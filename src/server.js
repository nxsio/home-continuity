import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { askNemotron } from './nemotron.js';

const config = {
  port: Number(process.env.HOME_PORT ?? 43188),
  databasePath: resolve(process.env.HOME_DB_PATH ?? '.local/home.sqlite'),
  continuityUrl: process.env.CONTINUITY_URL ?? 'http://127.0.0.1:43187/mcp'
};
const assets = new Map([
  ['/', { body: readFileSync(new URL('../public/index.html', import.meta.url)), type: 'text/html; charset=utf-8' }],
  ['/app.css', { body: readFileSync(new URL('../public/app.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
  ['/app.js', { body: readFileSync(new URL('../public/app.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }]
]);

mkdirSync(dirname(config.databasePath), { recursive: true });
const db = new DatabaseSync(config.databasePath);
db.exec(`
  CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY,
    household TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    title TEXT NOT NULL,
    dietary_note TEXT NOT NULL,
    source_utterance TEXT NOT NULL,
    memory_id INTEGER NOT NULL UNIQUE,
    person TEXT,
    restrictions_json TEXT,
    time_assumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(household, date, title)
  );
  CREATE TABLE IF NOT EXISTS shopping_items (
    id INTEGER PRIMARY KEY,
    household TEXT NOT NULL,
    date TEXT NOT NULL,
    item TEXT NOT NULL,
    source_event_id INTEGER NOT NULL REFERENCES calendar_events(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(household, date, item)
  );
  CREATE TABLE IF NOT EXISTS dinner_plans (
    id INTEGER PRIMARY KEY,
    household TEXT NOT NULL,
    date TEXT NOT NULL,
    command_key TEXT NOT NULL,
    event_id INTEGER NOT NULL REFERENCES calendar_events(id),
    plan_json TEXT NOT NULL,
    model_response_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(household, date, command_key)
  );
`);
const columns = new Set(db.prepare('PRAGMA table_info(calendar_events)').all().map(column => column.name));
for (const [name, definition] of [
  ['person', 'TEXT'],
  ['restrictions_json', 'TEXT'],
  ['time_assumed', 'INTEGER NOT NULL DEFAULT 0']
]) {
  if (!columns.has(name)) db.exec(`ALTER TABLE calendar_events ADD COLUMN ${name} ${definition}`);
}
db.prepare(`
  UPDATE calendar_events
  SET person = 'Mom', restrictions_json = '["peanuts"]', time_assumed = 1
  WHERE person IS NULL AND title = 'Dinner with Mom' AND dietary_note = 'No peanuts'
`).run();

const findEvents = db.prepare('SELECT * FROM calendar_events WHERE household = ? AND date = ? ORDER BY id');
const findEventByPerson = db.prepare('SELECT * FROM calendar_events WHERE household = ? AND date = ? AND person = ?');
const insertEvent = db.prepare(`
  INSERT INTO calendar_events
  (household, date, time, title, dietary_note, source_utterance, memory_id, person, restrictions_json, time_assumed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const findItems = db.prepare('SELECT item, source_event_id, created_at FROM shopping_items WHERE household = ? AND date = ? ORDER BY id');
const insertItem = db.prepare('INSERT OR IGNORE INTO shopping_items (household, date, item, source_event_id) VALUES (?, ?, ?, ?)');
const findPlan = db.prepare('SELECT * FROM dinner_plans WHERE household = ? AND date = ? AND command_key = ?');
const findLatestPlan = db.prepare('SELECT * FROM dinner_plans WHERE household = ? AND date = ? ORDER BY id DESC LIMIT 1');
const insertPlan = db.prepare(`
  INSERT OR IGNORE INTO dinner_plans (household, date, command_key, event_id, plan_json, model_response_json)
  VALUES (?, ?, ?, ?, ?, ?)
`);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function input(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'A JSON object is required.');
  const { household, date, utterance } = body;
  if (typeof household !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(household)) {
    throw new HttpError(422, 'household must contain 1–64 letters, numbers, underscores, or hyphens.');
  }
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new HttpError(422, 'date must be a real YYYY-MM-DD date.');
  }
  if (utterance !== undefined && (typeof utterance !== 'string' || !utterance.trim() || utterance.length > 500)) {
    throw new HttpError(422, 'utterance must be 1–500 characters of text.');
  }
  return { household, date, utterance: utterance?.trim() };
}

function eventFromRow(row) {
  if (!row.person || !row.restrictions_json) throw new Error(`Calendar event ${row.id} has incomplete visit details.`);
  return {
    id: row.id,
    household: row.household,
    date: row.date,
    time: row.time,
    title: row.title,
    person: row.person,
    restrictions: JSON.parse(row.restrictions_json),
    dietaryNote: row.dietary_note,
    sourceUtterance: row.source_utterance,
    memoryId: row.memory_id,
    timeNeedsConfirmation: Boolean(row.time_assumed),
    createdAt: row.created_at
  };
}

function memoryContext(household, date) {
  return `home-continuity:${household}:${date}`;
}

async function withMcp(run) {
  const client = new Client({ name: 'home-continuity', version: '0.2.0' });
  const transport = new StreamableHTTPClientTransport(new URL(config.continuityUrl));
  const started = performance.now();
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);
    for (const required of ['remember_commitment', 'recall_commitments', 'resume_commitment']) {
      if (!names.includes(required)) throw new Error(`Continuity Core is missing ${required}.`);
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
    return {
      value,
      mcp: {
        protocolVersion: client.getNegotiatedProtocolVersion(),
        server: client.getServerVersion(),
        tools: names,
        elapsedMs: Math.round(performance.now() - started)
      }
    };
  } finally {
    await client.close();
  }
}

function timeFromEvidence(evidence) {
  if (typeof evidence !== 'string') throw new Error('Nemotron did not cite the visit time.');
  const match = evidence.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (!match) throw new Error(`Nemotron returned an unreadable time quote: ${evidence}`);
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase().replaceAll('.', '');
  if (meridiem) {
    if (hour < 1 || hour > 12) throw new Error(`Invalid visit time: ${evidence}`);
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  } else if (hour >= 1 && hour <= 11) {
    hour += 12;
  }
  if (hour > 23) throw new Error(`Invalid visit time: ${evidence}`);
  return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, assumed: !meridiem && Number(match[1]) <= 12 };
}

function visitFromModel(raw, utterance) {
  const person = typeof raw?.person === 'string' ? raw.person.trim() : '';
  if (typeof person !== 'string' || !/^[\p{L}\p{M} .'-]{1,60}$/u.test(person) ||
      !utterance.toLocaleLowerCase().includes(person.toLocaleLowerCase())) {
    throw new Error(`Nemotron returned a visitor not found in the note: ${JSON.stringify(raw)}`);
  }
  if (typeof raw?.timeEvidence !== 'string' || !raw.timeEvidence.trim() ||
      !utterance.toLocaleLowerCase().includes(raw.timeEvidence.toLocaleLowerCase())) {
    throw new Error(`Nemotron returned a time quote not found in the note: ${JSON.stringify(raw)}`);
  }
  const parsedTime = timeFromEvidence(raw.timeEvidence);
  if (typeof raw.time !== 'string' || timeFromEvidence(raw.time).time !== parsedTime.time) {
    throw new Error(`Nemotron's visit time does not match its quote: ${JSON.stringify(raw)}`);
  }
  if (!Array.isArray(raw.restrictions) || raw.restrictions.length < 1 || raw.restrictions.length > 8) {
    throw new Error(`Nemotron returned no usable dietary notes: ${JSON.stringify(raw)}`);
  }
  const restrictions = raw.restrictions.map(value => typeof value === 'string' ? value.trim() : '');
  if (restrictions.some(value => !value || value.length > 80 ||
      !utterance.toLocaleLowerCase().includes(value.toLocaleLowerCase())) ||
      new Set(restrictions.map(value => value.toLocaleLowerCase())).size !== restrictions.length) {
    throw new Error(`Nemotron's dietary notes do not match the source note: ${JSON.stringify(raw)}`);
  }
  return { person, time: parsedTime.time, restrictions, timeNeedsConfirmation: parsedTime.assumed };
}

async function remember(body) {
  const { household, date, utterance } = input(body);
  if (!utterance) throw new HttpError(422, 'Tell me who is visiting, when, and what they cannot eat.');
  const model = await askNemotron([
    { role: 'system', content: 'Extract one dinner visit from the note. Return only a JSON object shaped {"person":"...","time":"HH:MM","timeEvidence":"...","restrictions":["...","..."]}. restrictions MUST be an array of individual food or diet terms copied verbatim from the note, without words such as "cannot have". Copy person and timeEvidence verbatim. For an hour without AM or PM, interpret 1–11 as evening for this dinner visit. If any required detail is missing, use null rather than inventing it.' },
    { role: 'user', content: JSON.stringify({ date, note: utterance }) }
  ], 500);
  const visit = visitFromModel(model.value, utterance);
  if (findEvents.all(household, date).length >= 8) {
    throw new HttpError(422, 'This date already has eight dinner visits.');
  }
  if (findEventByPerson.get(household, date, visit.person)) {
    throw new HttpError(409, `${visit.person}'s dinner is already on the calendar for ${date}.`);
  }
  const commitment = `${visit.person} visits on ${date} at ${visit.time}. Dietary notes: ${visit.restrictions.join(', ')}. Original note: ${utterance}`;
  const { value: saved, mcp } = await withMcp(call => call('remember_commitment', {
    context: memoryContext(household, date),
    commitment,
    next_action: `Plan dinner for ${visit.person} with these dietary notes and update the family shopping list.`,
    done_when: 'The family calendar and shopping list show the dinner plan.'
  }));
  if (!Number.isInteger(saved.id)) throw new Error('Continuity Core returned no memory ID.');
  insertEvent.run(
    household, date, visit.time, `Dinner with ${visit.person}`, visit.restrictions.join(', '),
    utterance, saved.id, visit.person, JSON.stringify(visit.restrictions), Number(visit.timeNeedsConfirmation)
  );
  const event = eventFromRow(findEventByPerson.get(household, date, visit.person));
  return {
    status: 'saved',
    memory: { id: saved.id, context: saved.context, commitment: saved.commitment },
    calendar: event,
    model: model.response,
    confirmations: event.timeNeedsConfirmation ? [`Confirm that ${model.value.timeEvidence} means ${event.time}.`] : [],
    mcp
  };
}

function planFromModel(raw, events, command) {
  if (raw?.intent === 'unrelated') throw new HttpError(422, 'This request does not ask to plan dinner.');
  if (raw?.intent !== 'dinner') throw new Error(`Nemotron returned no dinner intent: ${JSON.stringify(raw)}`);
  const event = events.find(item => item.id === raw.eventId);
  if (!event) throw new Error(`Nemotron chose a calendar event that does not exist: ${JSON.stringify(raw)}`);
  if (events.length > 1 && !command.toLocaleLowerCase().includes(event.person.toLocaleLowerCase())) {
    throw new HttpError(422, 'Name the visitor so I can choose the right dinner.');
  }
  if (raw.time !== event.time) throw new Error(`Nemotron changed the visit time: ${JSON.stringify(raw)}`);
  const expected = event.restrictions.map(value => value.toLocaleLowerCase()).sort();
  const echoed = Array.isArray(raw.restrictions) ? raw.restrictions.map(value => typeof value === 'string' ? value.toLocaleLowerCase() : '').sort() : [];
  if (JSON.stringify(expected) !== JSON.stringify(echoed)) {
    throw new Error(`Nemotron dropped or changed a dietary note: ${JSON.stringify(raw)}`);
  }
  const meal = typeof raw.meal === 'string' ? raw.meal.trim() : '';
  if (typeof meal !== 'string' || !meal || meal.length > 120) throw new Error(`Nemotron returned no usable meal: ${JSON.stringify(raw)}`);
  if (!Array.isArray(raw.ingredients) || raw.ingredients.length < 1 || raw.ingredients.length > 12) {
    throw new Error(`Nemotron returned no usable ingredient list: ${JSON.stringify(raw)}`);
  }
  const ingredients = raw.ingredients.map(value => typeof value === 'string' ? value.trim().toLocaleLowerCase() : '');
  if (ingredients.some(value => !value || value.length > 80) || new Set(ingredients).size !== ingredients.length) {
    throw new Error(`Nemotron returned duplicate or invalid ingredients: ${JSON.stringify(raw)}`);
  }
  const ingredientText = [meal.toLocaleLowerCase(), ...ingredients];
  const knownRestrictedTerms = {
    dairy: ['milk', 'cheese', 'cream', 'butter', 'yogurt', 'ghee', 'whey', 'casein'],
    peanut: ['peanut', 'groundnut'],
    mushroom: ['mushroom'],
    vegetarian: ['chicken', 'beef', 'pork', 'lamb', 'fish', 'seafood', 'shrimp', 'turkey', 'bacon'],
    vegan: ['chicken', 'beef', 'pork', 'lamb', 'fish', 'seafood', 'shrimp', 'turkey', 'bacon', 'egg', 'milk', 'cheese', 'cream', 'butter', 'yogurt', 'honey']
  };
  for (const restriction of event.restrictions) {
    const term = restriction.toLocaleLowerCase().replace(/^(?:no|avoid|without)\s+/, '').replace(/s$/, '');
    const blocked = [term, ...(knownRestrictedTerms[term] ?? [])];
    if (blocked.some(word => word.length >= 4 && ingredientText.some(value => value.includes(word)))) {
      throw new Error(`Nemotron included ${restriction} in the meal or shopping list: ${JSON.stringify(raw)}`);
    }
  }
  if (!Array.isArray(raw.confirmations) || raw.confirmations.length > 5 ||
      raw.confirmations.some(value => typeof value !== 'string' || !value.trim() || value.length > 160)) {
    throw new Error(`Nemotron returned invalid confirmation notes: ${JSON.stringify(raw)}`);
  }
  return {
    intent: 'dinner', eventId: event.id, time: event.time, restrictions: event.restrictions,
    meal, ingredients, confirmations: raw.confirmations.map(value => value.trim())
  };
}

function commandKey(utterance) {
  return utterance.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

async function pickUp(body) {
  const { household, date, utterance } = input(body);
  if (!utterance) throw new HttpError(422, 'Tell me which dinner to pick up.');
  const events = findEvents.all(household, date).map(eventFromRow);
  if (!events.length) throw new HttpError(409, 'There is no saved dinner on the calendar for this date.');
  const beforeModel = findItems.all(household, date);
  const key = commandKey(utterance);
  const cached = findPlan.get(household, date, key);
  const { value, mcp } = await withMcp(async call => {
    const recalled = await call('recall_commitments', { context: memoryContext(household, date) });
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
      const model = await askNemotron([
        { role: 'system', content: 'You plan one family dinner. Return only JSON with intent (dinner or unrelated), eventId, time, restrictions, meal, ingredients, and confirmations. If the request is unrelated to dinner, return {"intent":"unrelated"}. Choose an event from the calendar. Echo its time and restrictions exactly. Use its dietary notes as hard constraints; do not include a restricted ingredient. Give a specific meal and 3–8 distinct grocery ingredients, including ingredients already on the list so the app can subtract them. Suggest a different sensible meal when the visit or restriction changes. Do not claim a meal is medically safe. confirmations is an array of short things the person should check.' },
        { role: 'user', content: JSON.stringify({ request: utterance, date, calendar: events, remembered: recalled.commitments, shoppingList: beforeModel.map(item => item.item) }) }
      ], 950);
      plan = planFromModel(model.value, events, utterance);
      modelResponse = model.response;
    }
    const event = events.find(item => item.id === plan.eventId);
    const resumed = await call('resume_commitment', { id: event.memoryId });
    if (resumed.id !== event.memoryId || resumed.context !== memoryContext(household, date) ||
        !resumed.commitment?.includes(event.sourceUtterance)) {
      throw new Error('The saved memory does not match this calendar visit.');
    }
    return { plan, modelResponse, event, resumed, recalled: recalled.commitments.find(entry => entry.id === event.memoryId) };
  });

  const before = findItems.all(household, date);
  let stored = cached;
  let reused = Boolean(cached);
  const added = [];
  db.exec('BEGIN');
  try {
    if (!stored) {
      const insertion = insertPlan.run(household, date, key, value.event.id, JSON.stringify(value.plan), JSON.stringify(value.modelResponse));
      reused = insertion.changes === 0;
      stored = findPlan.get(household, date, key);
    }
    const persistedPlan = JSON.parse(stored.plan_json);
    for (const item of persistedPlan.ingredients) {
      const result = insertItem.run(household, date, item, stored.event_id);
      if (result.changes === 1) added.push(item);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const persistedPlan = JSON.parse(stored.plan_json);
  const event = events.find(item => item.id === stored.event_id);
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
    shopping: { before, added, after: findItems.all(household, date) },
    model: { ...JSON.parse(stored.model_response_json), reused },
    mcp
  };
}

function state(query) {
  const { household, date } = input({ household: query.get('household'), date: query.get('date') });
  const calendar = findEvents.all(household, date).map(eventFromRow);
  const latest = findLatestPlan.get(household, date);
  return {
    calendar,
    shopping: findItems.all(household, date),
    latestPlan: latest ? {
      ...JSON.parse(latest.plan_json),
      event: calendar.find(event => event.id === latest.event_id),
      model: JSON.parse(latest.model_response_json),
      createdAt: latest.created_at
    } : null
  };
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send application/json.');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new HttpError(413, 'Request body is too large.');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendAsset(res, asset) {
  res.writeHead(200, {
    'content-type': asset.type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:"
  });
  res.end(asset.body);
}

const server = createServer(async (req, res) => {
  const started = performance.now();
  try {
    const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
    if (req.method === 'GET' && assets.has(url.pathname)) {
      sendAsset(res, assets.get(url.pathname));
      return;
    }
    let result;
    if (req.method === 'POST' && url.pathname === '/api/remember') result = await remember(await readJson(req));
    else if (req.method === 'POST' && url.pathname === '/api/pick-up-dinner') result = await pickUp(await readJson(req));
    else if (req.method === 'GET' && url.pathname === '/api/state') result = state(url.searchParams);
    else throw new HttpError(404, 'Route not found.');
    send(res, 200, { ...result, elapsedMs: Math.round(performance.now() - started) });
  } catch (error) {
    console.error(error);
    send(res, error.status ?? 500, { status: 'error', error: error.message, elapsedMs: Math.round(performance.now() - started) });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Home Continuity listening at http://127.0.0.1:${config.port}`);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => db.close());
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
