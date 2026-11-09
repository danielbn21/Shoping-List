// City names. Stores files give the city as a numeric locality code (CBS "symbol", e.g. 6400); the government publishes the list on
// data.gov.il (the same source the plugin uses). A small built-in seed covers the biggest cities until that list has been loaded.
export const GOV_URL = 'https://data.gov.il/api/3/action/datastore_search';
export const GOV_RESOURCE = '5c78e9fa-c2e2-4771-93ff-7f400a12f7ba';

// Codes confirmed against real Stores files or well known; replaced by the government list as soon as it loads.
const SEED = {
  3000: 'ירושלים', 5000: 'תל אביב - יפו', 4000: 'חיפה', 8300: 'ראשון לציון', 7900: 'פתח תקווה', 70: 'אשדוד', 7400: 'נתניה', 9000: 'באר שבע',
  6100: 'בני ברק', 6600: 'חולון', 8600: 'רמת גן', 8400: 'רחובות', 6400: 'הרצליה', 6200: 'בת ים', 7100: 'אשקלון', 6900: 'כפר סבא',
  9700: 'הוד השרון', 8700: 'רעננה', 6300: 'גבעתיים', 1200: 'מודיעין-מכבים-רעות', 7000: 'לוד', 8500: 'רמלה', 9100: 'נהריה', 2600: 'אילת',
  240: 'יוקנעם עילית', 96: 'יגור', 250: 'הזורע',
};

export const cityKey = (raw) => { const s = String(raw ?? '').trim(); return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s; };

export function seedCities(db) {
  const ins = db.prepare("INSERT OR IGNORE INTO city_names(code, name, source) VALUES (?, ?, 'seed')");
  db.transaction(() => { for (const [c, n] of Object.entries(SEED)) ins.run(String(c), n); })();
}

export async function refreshCityNames({ db, http, url = GOV_URL, now = Date.now }) {
  const r = await http.request(`${url}?resource_id=${GOV_RESOURCE}&limit=5000`, { timeout: 60_000 });
  let j;
  try { j = JSON.parse(r.text()); } catch { throw new Error('city list is not JSON'); }
  const recs = j?.result?.records;
  if (!Array.isArray(recs) || !recs.length) throw new Error('city list is empty');
  const up = db.prepare("INSERT INTO city_names(code, name, source) VALUES (?, ?, 'gov') ON CONFLICT(code) DO UPDATE SET name = excluded.name, source = 'gov'");
  let n = 0;
  db.transaction(() => {
    for (const x of recs) {
      const code = parseInt(x['סמל_ישוב'], 10), name = String(x['שם_ישוב'] ?? '').trim().replace(/\s+/g, ' ');
      if (code > 0 && name) { up.run(String(code), name); n++; }
    }
    db.prepare("INSERT INTO portal_meta(key, value) VALUES ('cities_fetched_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now()));
  })();
  return n;
}

export const citiesFetchedAt = (db) => Number(db.prepare("SELECT value FROM portal_meta WHERE key = 'cities_fetched_at'").get()?.value || 0);
