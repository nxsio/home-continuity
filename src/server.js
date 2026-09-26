import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const config = {
  port: Number(process.env.HOME_PORT ?? 43188),
  databasePath: resolve(process.env.HOME_DB_PATH ?? '.local/home.sqlite'),
  continuityUrl: process.env.CONTINUITY_URL ?? 'http://127.0.0.1:43187/mcp'
};

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
`);

const findEvent = db.prepare('SELECT * FROM calendar_events WHERE household = ? AND date = ? AND title = ?');
const insertEvent = db.prepare('INSERT INTO calendar_events (household, date, time, title, dietary_note, source_utterance, memory_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
const findItems = db.prepare('SELECT item, source_event_id, created_at FROM shopping_items WHERE household = ? AND date = ? ORDER BY id');
const insertItem = db.prepare('INSERT OR IGNORE INTO shopping_items (household, date, item, source_event_id) VALUES (?, ?, ?, ?)');
const dinnerTitle = 'Dinner with Mom';
const dinnerItems = ['pasta', 'tomatoes', 'basil', 'olive oil'];

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
  if (utterance !== undefined && (typeof utterance !== 'string' || utterance.length > 500)) {
    throw new HttpError(422, 'utterance must be text of at most 500 characters.');
  }
  return { household, date, utterance };
}

function memoryContext(household, date) {
  return `home-continuity:${household}:${date}`;
}

async function withMcp(run) {
  const client = new Client({ name: 'home-continuity', version: '0.1.0' });
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

async function remember(body) {
  const { household, date, utterance } = input(body);
  if (!utterance || !/\bmom\b/i.test(utterance) || !/\bat\s+(?:7(?::00)?|seven)\b/i.test(utterance) ||
      !/(?:can't|cannot|can not)\s+(?:have|eat)\s+peanuts\b|\bpeanut[- ]free\b/i.test(utterance)) {
    throw new HttpError(422, 'This demo saves a visit from Mom at 7 with a peanut restriction.');
  }
  if (findEvent.get(household, date, dinnerTitle)) {
    throw new HttpError(409, 'This dinner is already on the calendar. Read /api/state or use another date.');
  }
  const commitment = `Mom visits on ${date} at 7 PM. She cannot have peanuts. Source: ${utterance}`;
  const { value: saved, mcp } = await withMcp(call => call('remember_commitment', {
    context: memoryContext(household, date),
    commitment,
    next_action: 'Plan dinner without peanuts and update the family shopping list.',
    done_when: 'The family calendar and shopping list show the dinner plan.'
  }));
  if (!Number.isInteger(saved.id)) throw new Error('Continuity Core returned no memory ID.');
  insertEvent.run(household, date, '19:00', dinnerTitle, 'No peanuts', utterance, saved.id);
  const event = findEvent.get(household, date, dinnerTitle);
  return {
    status: 'saved',
    memory: { id: saved.id, context: saved.context, commitment: saved.commitment },
    calendar: event,
    mcp
  };
}

async function pickUp(body) {
  const { household, date, utterance } = input(body);
  if (!utterance || !/\bdinner\b/i.test(utterance) || !/\bmom\b/i.test(utterance)) {
    throw new HttpError(422, 'This demo picks up dinner for Mom.');
  }
  const { value: memory, mcp } = await withMcp(async call => {
    const recalled = await call('recall_commitments', { context: memoryContext(household, date) });
    if (!Array.isArray(recalled.commitments)) throw new Error('Continuity Core returned no commitment list.');
    const event = findEvent.get(household, date, dinnerTitle);
    if (!event) throw new HttpError(409, 'No dinner for Mom is saved on the family calendar for this date.');
    const found = recalled.commitments.find(entry => entry.id === event.memory_id);
    if (!found) throw new HttpError(409, 'The calendar entry has no matching saved memory.');
    const resumed = await call('resume_commitment', { id: found.id });
    if (resumed.id !== event.memory_id || resumed.context !== memoryContext(household, date) ||
        !/cannot have peanuts/i.test(resumed.commitment ?? '')) {
      throw new Error('The saved memory does not match this dinner or its peanut restriction.');
    }
    return { found, resumed, event };
  });

  const before = findItems.all(household, date);
  const added = [];
  db.exec('BEGIN');
  try {
    for (const item of dinnerItems) {
      const result = insertItem.run(household, date, item, memory.event.id);
      if (result.changes === 1) added.push(item);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const after = findItems.all(household, date);
  return {
    status: 'completed',
    card: {
      title: 'Dinner for Mom',
      time: `${date} 19:00`,
      dietaryNote: memory.event.dietary_note,
      nextStep: memory.resumed.next_step,
      shopping: added.length ? `${added.length} items added` : 'Shopping list already up to date'
    },
    sources: {
      remembered: memory.found,
      resumed: memory.resumed,
      calendar: memory.event
    },
    shopping: { before, added, after },
    mcp
  };
}

function state(query) {
  const { household, date } = input({ household: query.get('household'), date: query.get('date') });
  return {
    calendar: findEvent.get(household, date, dinnerTitle) ?? null,
    shopping: findItems.all(household, date)
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

const server = createServer(async (req, res) => {
  const started = performance.now();
  try {
    const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
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

function shutdown() {
  server.close(() => db.close());
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
