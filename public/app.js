const ids = [
  'household', 'date', 'service-status', 'error-box', 'error-title', 'error-message',
  'remember-form', 'pickup-form', 'visit-note', 'pickup-note', 'remember-button',
  'pickup-button', 'remember-status', 'pickup-status', 'result-empty', 'result-card',
  'calendar-count', 'calendar-list', 'shopping-count', 'shopping-list', 'copy-shopping', 'copy-shopping-status'
];
const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
ui.status = document.querySelector('.service-status');

function localTomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const query = new URLSearchParams(window.location.search);
ui.household.value = query.get('household') || 'family';
ui.date.value = query.get('date') || localTomorrow();
let visibleResultKey = null;
let stateRequest = 0;
let shoppingItems = [];

ui['copy-shopping'].addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shoppingItems.join('\n'));
    ui['copy-shopping-status'].textContent = 'List copied. Paste it where you shop.';
  } catch {
    ui['copy-shopping-status'].textContent = 'Copy unavailable. Select the items above instead.';
  }
});

function context() {
  return { household: ui.household.value.trim(), date: ui.date.value };
}

function contextKey() {
  const { household, date } = context();
  return `${household}:${date}`;
}

function rememberContextInUrl() {
  const url = new URL(window.location.href);
  const { household, date } = context();
  url.searchParams.set('household', household);
  url.searchParams.set('date', date);
  window.history.replaceState(null, '', url);
}

function setStatus(message, tone = 'ready') {
  ui['service-status'].textContent = message;
  ui.status.dataset.tone = tone;
}

function showError(title, error) {
  ui['error-title'].textContent = title;
  ui['error-message'].textContent = error instanceof Error ? error.message : String(error);
  ui['error-box'].hidden = false;
}

function clearError() {
  ui['error-box'].hidden = true;
  ui['error-title'].textContent = '';
  ui['error-message'].textContent = '';
}

function setBusy(busy) {
  for (const control of [ui.household, ui.date, ui['visit-note'], ui['pickup-note'], ui['remember-button'], ui['pickup-button']]) {
    control.disabled = busy;
  }
}

async function request(path, body) {
  const response = await fetch(path, body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  } : { cache: 'no-store' });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The service returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error || `The service returned HTTP ${response.status}.`);
  return data;
}

function element(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = String(text);
  return node;
}

function calendarText(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(';', '\\;').replaceAll(',', '\\,');
}

function downloadCalendarEvent(visit) {
  const date = String(visit.date).replaceAll('-', '');
  const time = String(visit.time).replace(':', '');
  if (!/^\d{8}$/.test(date) || !/^\d{4}$/.test(time)) {
    showError('Calendar download unavailable', 'The saved visit has an invalid date or time.');
    return;
  }
  const note = [visit.sourceUtterance, `Food to avoid: ${visit.restrictions.join(', ')}`].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NXSIO//Home Continuity//EN',
    'BEGIN:VEVENT', `UID:${crypto.randomUUID()}@home-continuity.nxsio.com`,
    `DTSTAMP:${new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z')}`,
    `DTSTART:${date}T${time}00`, `SUMMARY:${calendarText(visit.title)}`,
    `DESCRIPTION:${calendarText(note)}`, 'END:VEVENT', 'END:VCALENDAR'
  ];
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = `dinner-visit-${visit.date}.ics`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function chips(values, neutral = false) {
  const group = element('div', 'chips');
  for (const value of values) group.append(element('span', neutral ? 'chip neutral' : 'chip', value));
  return group;
}

function row(target, label, value, note = '') {
  const item = element('div', 'result-row');
  item.append(element('span', 'key', label));
  const content = element('div', 'value');
  content.append(value instanceof Node ? value : document.createTextNode(String(value)));
  if (note) content.append(element('small', '', note));
  item.append(content);
  target.append(item);
}

function details(target, label, lines, raw = '') {
  const section = element('details', 'detail');
  section.append(element('summary', '', label));
  for (const line of lines.filter(Boolean)) section.append(element('p', '', line));
  if (raw) section.append(element('pre', '', raw));
  target.append(section);
}

function cardStart(title, time, badge) {
  const card = ui['result-card'];
  card.replaceChildren();
  const head = element('div', 'result-head');
  head.append(element('h2', '', title), element('span', 'result-badge', badge));
  card.append(head, element('div', 'result-time', time));
  ui['result-empty'].hidden = true;
  card.hidden = false;
  return card;
}

function addConfirmations(card, items) {
  if (!items?.length) return;
  const list = element('ul', 'confirmations');
  for (const item of items) list.append(element('li', '', item));
  card.append(list);
}

function addMeal(card, meal) {
  const block = element('div', 'result-meal');
  block.append(element('span', 'key', 'Dinner plan'), element('strong', '', meal));
  card.append(block);
}

function renderSaved(data) {
  const visit = data.calendar;
  const card = cardStart(visit.title, `${visit.date} · ${visit.time}`, 'Visit saved');
  row(card, 'Food to avoid', chips(visit.restrictions));
  row(card, 'Next', 'Come back and ask to pick up dinner.');
  addConfirmations(card, data.confirmations);
  details(card, 'Original note', [visit.sourceUtterance]);
  details(card, 'Technical trace', [`Saved memory #${visit.memoryId}`, `MCP ${data.mcp.protocolVersion}`], data.model.rawContent);
  ui['remember-status'].textContent = 'Saved';
}

function renderCompleted(data) {
  const plan = data.card;
  const card = cardStart(plan.title, plan.time, data.shopping.added.length ? 'List updated' : 'List already set');
  addMeal(card, plan.meal);
  row(card, 'Food to avoid', chips(plan.dietaryNotes));
  row(card, 'Added now', data.shopping.added.length ? chips(data.shopping.added) : 'No new items needed',
    `${data.shopping.before.length} before · ${data.shopping.after.length} now`);
  addConfirmations(card, plan.confirmations);
  details(card, 'What carried over', [data.sources.calendar.sourceUtterance, data.sources.resumed.next_step]);
  const trace = [`Saved memory #${data.sources.resumed.id}`, `MCP ${data.mcp.protocolVersion}`];
  if (data.model.provider === 'bedrock') {
    trace.unshift(`${data.model.reused ? 'Saved via' : 'This request used'} AgentCore → Bedrock ${data.model.model} → MCP ${data.mcp.tools.join(', ')}`);
    if (data.model.agentCoreRequestId) trace.push(`AgentCore request ${data.model.agentCoreRequestId}`);
  }
  details(card, 'Technical trace', trace, data.model.rawContent);
  ui['pickup-status'].textContent = 'Completed';
}

function renderPersistedPlan(plan, shoppingCount) {
  if (!plan.event) throw new Error('The saved dinner plan has no matching calendar visit.');
  const card = cardStart(plan.event.title, `${plan.event.date} · ${plan.event.time}`, 'Saved plan');
  addMeal(card, plan.meal);
  row(card, 'Food to avoid', chips(plan.event.restrictions));
  row(card, 'Ingredients', chips(plan.ingredients, true), `${shoppingCount} items on the shopping list`);
  addConfirmations(card, [...plan.confirmations, `Check ingredient labels against ${plan.event.person}'s dietary notes before serving.`]);
  details(card, 'What carried over', [plan.event.sourceUtterance]);
  details(card, 'Technical trace', [
    `Saved memory #${plan.event.memoryId}`,
    ...(plan.model.provider === 'bedrock' ? [`Saved via AgentCore → Bedrock ${plan.model.model} → MCP`] : [])
  ], plan.model.rawContent);
}

function clearResult() {
  ui['result-card'].replaceChildren();
  ui['result-card'].hidden = true;
  ui['result-empty'].hidden = false;
}

function renderState(data) {
  if (!Array.isArray(data.calendar) || !Array.isArray(data.shopping)) {
    throw new Error('The service returned an incomplete family calendar.');
  }
  ui['calendar-count'].textContent = `${data.calendar.length} saved`;
  ui['calendar-list'].replaceChildren();
  if (!data.calendar.length) ui['calendar-list'].append(element('p', '', 'No visit saved for this date.'));
  for (const visit of data.calendar) {
    const item = element('div', 'event');
    item.append(element('strong', '', visit.title), element('span', '', `${visit.time} · Avoid ${visit.restrictions.join(', ')}`));
    const download = element('button', 'copy-action', 'Download calendar event');
    download.type = 'button';
    download.addEventListener('click', () => downloadCalendarEvent(visit));
    item.append(download);
    ui['calendar-list'].append(item);
  }

  ui['shopping-count'].textContent = `${data.shopping.length} items`;
  shoppingItems = data.shopping.map(entry => entry.item);
  ui['copy-shopping'].hidden = shoppingItems.length === 0;
  ui['copy-shopping-status'].textContent = '';
  ui['shopping-list'].replaceChildren();
  if (!data.shopping.length) ui['shopping-list'].append(element('p', '', 'Nothing on the list yet.'));
  else {
    const list = element('ul', 'shopping-items');
    for (const entry of data.shopping) list.append(element('li', '', entry.item));
    ui['shopping-list'].append(list);
  }

  ui['remember-status'].textContent = data.calendar.length ? 'Saved' : '';
  ui['pickup-status'].textContent = data.latestPlan ? 'Completed' : '';
  if (visibleResultKey !== contextKey()) {
    if (data.latestPlan) renderPersistedPlan(data.latestPlan, data.shopping.length);
    else clearResult();
  }
}

async function loadState(announce = true) {
  const snapshot = context();
  const key = contextKey();
  const requestId = ++stateRequest;
  if (announce) setStatus('Loading your family calendar…', 'working');
  const params = new URLSearchParams(snapshot);
  const data = await request(`/api/state?${params}`);
  if (requestId !== stateRequest || key !== contextKey()) return;
  renderState(data);
  if (announce) setStatus('Family calendar loaded', 'ready');
}

async function runAction(path, utterance, render, working, completed, failed) {
  if (!ui.household.reportValidity() || !ui.date.reportValidity()) return;
  rememberContextInUrl();
  clearError();
  setBusy(true);
  setStatus(working, 'working');
  let delivered = false;
  try {
    const data = await request(path, { ...context(), utterance });
    delivered = true;
    visibleResultKey = contextKey();
    render(data);
    setStatus(completed, 'ready');
    await loadState(false);
  } catch (error) {
    showError(delivered ? 'The result was saved, but the page could not finish updating.' : failed, error);
    setStatus(delivered ? completed : 'The request did not finish', delivered ? 'ready' : 'error');
  } finally {
    setBusy(false);
  }
}

ui['remember-form'].addEventListener('submit', event => {
  event.preventDefault();
  void runAction('/api/remember', ui['visit-note'].value.trim(), renderSaved,
    'Saving the visit…', 'Visit saved to the family calendar', 'Could not save this visit.');
});

ui['pickup-form'].addEventListener('submit', event => {
  event.preventDefault();
  void runAction('/api/pick-up-dinner', ui['pickup-note'].value.trim(), renderCompleted,
    'Finding the visit and planning dinner…', 'Dinner plan and shopping list ready', 'Could not finish this dinner.');
});

for (const control of [ui.household, ui.date]) {
  control.addEventListener('change', () => {
    if (!ui.household.reportValidity() || !ui.date.reportValidity()) return;
    rememberContextInUrl();
    visibleResultKey = null;
    clearResult();
    clearError();
    void loadState().catch(error => {
      showError('Could not load this family calendar.', error);
      setStatus('The service is unavailable', 'error');
    });
  });
}

rememberContextInUrl();
void loadState().catch(error => {
  showError('Could not load this family calendar.', error);
  setStatus('The service is unavailable', 'error');
});
