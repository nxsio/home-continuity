CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE calendar_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  household TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  title TEXT NOT NULL,
  dietary_note TEXT NOT NULL,
  source_utterance TEXT NOT NULL,
  memory_id INTEGER NOT NULL UNIQUE,
  person TEXT NOT NULL,
  restrictions_json TEXT NOT NULL,
  time_assumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(session_id, household, date, title)
);

CREATE INDEX calendar_by_visit ON calendar_events(session_id, household, date, id);

CREATE TABLE shopping_items (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  household TEXT NOT NULL,
  date TEXT NOT NULL,
  item TEXT NOT NULL,
  source_event_id INTEGER NOT NULL REFERENCES calendar_events(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(session_id, household, date, item)
);

CREATE INDEX shopping_by_visit ON shopping_items(session_id, household, date, id);

CREATE TABLE dinner_plans (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  household TEXT NOT NULL,
  date TEXT NOT NULL,
  command_key TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id),
  plan_json TEXT NOT NULL,
  model_response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(session_id, household, date, command_key)
);

CREATE INDEX plans_by_visit ON dinner_plans(session_id, household, date, id DESC);

CREATE TABLE model_quota (
  quota_key TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0,
  cap INTEGER NOT NULL,
  CHECK (used >= 0 AND used <= cap)
);
