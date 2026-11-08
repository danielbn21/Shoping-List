import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  try {
    const [alg, n, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const h = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: R, p: P });
    return crypto.timingSafeEqual(h, expected);
  } catch {
    return false;
  }
}

// Used to keep login timing similar whether or not the user exists.
export const DUMMY_HASH = await hashPassword('not-a-real-password');

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid typos
function randomString(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
export const generateOneTimePassword = () => randomString(12);
export const generateInviteCode = () => randomString(8);
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function deviceLabel(ua = '') {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

// ---- settings (admin-configurable, stored as JSON in the settings table) ----
export const SETTING_DEFAULTS = {
  registration_mode: 'invite-only', // open | invite-only | admin-only
  session_days: 365,
  min_password_length: 8,
  app_url: '',
  match_strictness: 'normal', // used by duplicate detection (Stage 2)
  allow_user_households: true, // may ordinary users create their own households?
  ocr_enabled: true, // receipt scanning (local Tesseract, or a user's own cloud key)
  branch_cache_days: 7, // how long the branch directory (from the chains' Stores files) is reused
  compare_enabled: true, // the "Compare prices" tab on lists (Israeli shekel users only)
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  default_categories: [
    { en: 'Produce', he: 'פירות וירקות' },
    { en: 'Bakery', he: 'מאפים ולחם' },
    { en: 'Dairy & eggs', he: 'מוצרי חלב וביצים' },
    { en: 'Meat & fish', he: 'בשר ודגים' },
    { en: 'Frozen', he: 'קפואים' },
    { en: 'Pantry', he: 'מזווה' },
    { en: 'Snacks & sweets', he: 'חטיפים וממתקים' },
    { en: 'Drinks', he: 'משקאות' },
    { en: 'Cleaning', he: 'ניקיון' },
    { en: 'Personal care', he: 'טיפוח והיגיינה' },
    { en: 'Baby', he: 'תינוקות' },
    { en: 'Pets', he: 'חיות מחמד' },
  ],
};

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return structuredClone(SETTING_DEFAULTS[key]);
  try { return JSON.parse(row.value); } catch { return structuredClone(SETTING_DEFAULTS[key]); }
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
export function allSettings(db) {
  const out = {};
  for (const k of Object.keys(SETTING_DEFAULTS)) out[k] = getSetting(db, k);
  return out;
}

export function audit(db, actorId, action, target = null, detail = null) {
  db.prepare('INSERT INTO audit_log(ts, actor_id, action, target, detail) VALUES (?,?,?,?,?)')
    .run(Date.now(), actorId ?? null, action, target, detail ? JSON.stringify(detail) : null);
}

// ---- users & households ----
export function createHousehold(db, name, ownerId) {
  const now = Date.now();
  const hid = db.prepare('INSERT INTO households(name, created_at) VALUES (?, ?)').run(name, now).lastInsertRowid;
  if (ownerId) db.prepare("INSERT INTO household_members(household_id, user_id, role) VALUES (?, ?, 'owner')").run(hid, ownerId);
  const ins = db.prepare('INSERT INTO categories(household_id, name_en, name_he, sort) VALUES (?,?,?,?)');
  getSetting(db, 'default_categories').forEach((c, i) => ins.run(hid, c.en, c.he, i));
  return Number(hid);
}

export function createUser(db, { username, name, email, passwordHash, role = 'user', mustChange = 0, language = 'en' }) {
  const r = db.prepare(`INSERT INTO users(username, email, name, password_hash, role, language, must_change_password, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(username, email || null, name, passwordHash, role, language, mustChange, Date.now());
  return Number(r.lastInsertRowid);
}

export function userPayload(db, u) {
  const households = db.prepare(`SELECT h.id, h.name, m.role FROM household_members m
    JOIN households h ON h.id = m.household_id
    LEFT JOIN user_household_order o ON o.user_id = m.user_id AND o.household_id = h.id
    WHERE m.user_id = ? ORDER BY COALESCE(o.position, 1000000), h.id`).all(u.id);
  return {
    id: u.id, username: u.username, email: u.email, name: u.name, role: u.role,
    language: u.language, theme: u.theme, colorTheme: u.color_theme,
    showAddedBy: !!u.show_added_by, mustChangePassword: !!u.must_change_password,
    households,
    canCreateHousehold: u.role === 'admin' || !!getSetting(db, 'allow_user_households'),
    currency: u.currency ?? null,
    ocrEnabled: !!getSetting(db, 'ocr_enabled'),
    compareEnabled: !!getSetting(db, 'compare_enabled'),
    ocr: (() => {
      const o = db.prepare('SELECT engine, provider, model, api_key_enc FROM user_ocr WHERE user_id = ?').get(u.id);
      return { engine: o?.engine ?? 'auto', provider: o?.provider ?? 'anthropic', model: o?.model ?? '', hasKey: !!o?.api_key_enc };
    })(),
  };
}

export const validUsername = (u) => typeof u === 'string' && /^[\p{L}\p{N}._-]{2,40}$/u.test(u);
export const validEmail = (e) => typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const cleanName = (n) => (typeof n === 'string' ? n.trim().slice(0, 80) : '');
