export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function input(body) {
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

export function eventFromRow(row) {
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

export function timeFromEvidence(evidence) {
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

export function visitFromModel(raw, utterance) {
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

export function planFromModel(raw, events, command) {
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

export function commandKey(utterance) {
  return utterance.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}
