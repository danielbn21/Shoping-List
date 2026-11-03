import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Schema is versioned with PRAGMA user_version. Append new migrations; never edit old ones.
const MIGRATIONS = [
`
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  language TEXT NOT NULL DEFAULT 'en',
  theme TEXT NOT NULL DEFAULT 'system',
  color_theme TEXT NOT NULL DEFAULT 'green',
  show_added_by INTEGER NOT NULL DEFAULT 0,
  default_store_id INTEGER,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE UNIQUE INDEX users_email_uq ON users(email) WHERE email IS NOT NULL;

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT,
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE password_resets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE households (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE household_members (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE lists (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  image TEXT,
  color TEXT,
  visibility TEXT NOT NULL DEFAULT 'household' CHECK (visibility IN ('household','private')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE list_members (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'contributor' CHECK (role IN ('owner','contributor','viewer')),
  PRIMARY KEY (list_id, user_id)
);

CREATE TABLE invites (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('household','list')),
  household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
  list_id INTEGER REFERENCES lists(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name_en TEXT NOT NULL,
  name_he TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  seasonal_tag TEXT
);

-- The item bank: every distinct item the household has ever used.
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  language TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  default_unit TEXT,
  seasonal_tag TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX items_household_norm ON items(household_id, name_norm);

CREATE TABLE list_entries (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  note TEXT,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','in_cart')),
  checked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checked_at INTEGER,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX list_entries_list ON list_entries(list_id);

CREATE TABLE stores (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE TABLE store_layouts (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (store_id, category_id)
);
CREATE TABLE store_item_overrides (
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  position INTEGER,
  PRIMARY KEY (store_id, item_id)
);

CREATE TABLE trips (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  shopper_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- Groundwork for smart suggestions: one row per purchased item per trip.
CREATE TABLE purchase_events (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  buyer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  purchased_at INTEGER NOT NULL
);
CREATE INDEX purchase_events_item ON purchase_events(household_id, item_id, purchased_at);

CREATE TABLE suggestion_events (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('shown','accepted','dismissed')),
  context TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE notification_rules (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  min_items INTEGER NOT NULL DEFAULT 1,
  days TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL DEFAULT '17:00',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
// 2: manual ordering of entries inside a list (drag and drop)
`
ALTER TABLE list_entries ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
UPDATE list_entries SET position = id;
`,
// 3: item default note + price, price on purchases (history groundwork), personal ordering of households and lists
`
ALTER TABLE items ADD COLUMN default_note TEXT;
ALTER TABLE items ADD COLUMN price REAL;
ALTER TABLE purchase_events ADD COLUMN unit_price REAL;
ALTER TABLE purchase_events ADD COLUMN line_total REAL;
CREATE TABLE user_household_order (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, household_id)
);
CREATE TABLE user_list_order (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, list_id)
);
`,
// 4: trip totals and currency, receipt photos with OCR results, per-user currency and OCR (cloud key stored encrypted)
`
ALTER TABLE trips ADD COLUMN total REAL;
ALTER TABLE trips ADD COLUMN currency TEXT;
ALTER TABLE users ADD COLUMN currency TEXT;
CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at INTEGER NOT NULL,
  ocr_status TEXT NOT NULL DEFAULT 'none' CHECK (ocr_status IN ('none','pending','done','failed')),
  ocr_engine TEXT,
  ocr_result TEXT,
  ocr_error TEXT
);
CREATE INDEX receipts_trip ON receipts(trip_id);
CREATE TABLE user_ocr (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  engine TEXT NOT NULL DEFAULT 'auto' CHECK (engine IN ('auto','local','cloud')),
  provider TEXT,
  model TEXT,
  api_key_enc TEXT
);
`,
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'shoplist.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}
