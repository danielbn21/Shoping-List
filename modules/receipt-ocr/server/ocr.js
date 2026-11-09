import { spawn } from 'node:child_process';
import fs from 'node:fs';

/* ------------------------------------------------------------------ local engine: Tesseract ------------------------------------------------------------------ */

export function runTesseract(file, { langs = process.env.OCR_LANGS || 'heb+eng', psm = '6', timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('tesseract', [file, 'stdout', '-l', langs, '--psm', psm]);
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ocr_timeout')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'tesseract_not_installed' : e.message)); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`tesseract_failed: ${err.slice(0, 200)}`)); });
  });
}

const PRICE = /(?<![\d.,])(\d{1,6}[.,]\d{2})(?!\d)/g;
const TOTAL_WORDS = /(total|amount due|balance due|sum\b|סה["'״]?כ|סהכ|לתשלום|סך הכל|סכום|כ["'״]?הס|םולשתל|םוכס)/i;
const SKIP_WORDS = /(\bvat\b|\btax\b|change|\bcash\b|credit|visa|master ?card|מע["'״]?מ|מזומן|עודף|אשראי|תאריך|\bdate\b|invoice|חשבונית|\btel\b|phone|טלפון|receipt|קבלה|\bcard\b|כרטיס|discount|הנחה|ח["'״]?פ)/i;
const CURRENCY_MARKS = /(₪|\$|€|£|nis|ש["'״]ח|שקל)/gi;
const num = (s) => Number(String(s).replace(',', '.'));
const round2 = (n) => Math.round(n * 100) / 100;

const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const HEB_RUN = /[\u0590-\u05FF](?:[\u0590-\u05FF\s"'\u05F3\u05F4.\-%]*[\u0590-\u05FF])?/g;
const FINALS = '\u05DA\u05DD\u05DF\u05E3\u05E5'; // ך ם ן ף ץ

// Tesseract often returns Hebrew in visual (left-to-right) order on receipts where a number sits at the line start.
// Final-form letters only occur at the END of a word, so words that START with one show the text is reversed.
export function hebrewLooksReversed(text) {
  let rev = 0, ok = 0;
  for (const w of String(text).replace(BIDI_MARKS, '').split(/\s+/)) {
    const h = w.replace(/[^\u05D0-\u05EA]/g, '');
    if (h.length < 2) continue;
    if (FINALS.includes(h[0])) rev++;
    if (FINALS.includes(h[h.length - 1])) ok++;
  }
  return rev > ok;
}
export const reverseHebrewRuns = (s) => String(s).replace(HEB_RUN, (r) => [...r].reverse().join(''));

// Turn raw receipt text into candidate lines and a total. This is a best-effort parser: the review screen exists so a person confirms it.
export function parseReceiptText(text) {
  const lines = [];
  let total = null;
  const clean = String(text).replace(BIDI_MARKS, '');
  const reversed = hebrewLooksReversed(clean);
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const prices = [...line.matchAll(PRICE)].map((m) => ({ v: num(m[1]), i: m.index, s: m[0] }));
    if (!prices.length) continue;
    if (TOTAL_WORDS.test(line)) { const m = Math.max(...prices.map((p) => p.v)); if (total === null || m >= total) total = m; continue; }
    if (SKIP_WORDS.test(line)) continue;

    // Names are printed on one side, prices on the other; right-to-left receipts come out price-first.
    const priceFirst = prices[0].i <= 2;
    let name = line.replace(PRICE, ' ').replace(CURRENCY_MARKS, ' ');
    let quantity = 1, unitPrice = null, lineTotal = priceFirst ? prices[0].v : prices[prices.length - 1].v;

    const qx = name.match(/(\d+(?:[.,]\d+)?)\s*[x×*@]\s*(?=\s|$)|[x×*]\s*(\d+(?:[.,]\d+)?)(?=\s|$)/i);
    if (qx) { quantity = num(qx[1] ?? qx[2]); name = name.replace(qx[0], ' '); }
    if (prices.length >= 2) {
      const a = priceFirst ? prices[1].v : prices[0].v;      // candidate unit price
      const b = priceFirst ? prices[0].v : prices[prices.length - 1].v; // candidate line total
      const ratio = a > 0 ? b / a : 0;
      if (Math.abs(ratio - Math.round(ratio)) < 0.02 && Math.round(ratio) >= 2) { unitPrice = a; lineTotal = b; if (quantity === 1) quantity = Math.round(ratio); }
      else if (qx) { unitPrice = a; lineTotal = b; }
    } else if (qx) unitPrice = round2(lineTotal / quantity);

    name = name.replace(/[^\p{L}\p{N}%.\-'"/ ]+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/^[\d.\-]+\s+(?=\p{L})/u, '').trim();
    if (name.length < 2 || !/\p{L}/u.test(name)) continue;
    if (reversed) name = reverseHebrewRuns(name);
    if (!(quantity > 0 && quantity < 1000)) quantity = 1;
    lines.push({ name, quantity, unitPrice: unitPrice ?? round2(lineTotal / quantity), lineTotal: round2(lineTotal) });
  }
  return { lines, total };
}

/* ------------------------------------------------------------------ cloud engines (the user's own API key) ------------------------------------------------------------------ */

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', model: 'claude-sonnet-5-5' },
  openai: { label: 'OpenAI', model: 'gpt-4o' },
  gemini: { label: 'Google (Gemini)', model: 'gemini-2.0-flash' },
};

const PROMPT = `You read shopping receipts (Hebrew or English). Reply with ONLY a JSON object, no prose, in this shape:
{"store": string|null, "date": "YYYY-MM-DD"|null, "currency": "ISO 4217 code"|null, "total": number|null,
 "items": [{"name": string, "quantity": number, "unit_price": number|null, "line_total": number|null}]}
Keep product names exactly as printed. Quantity defaults to 1. Leave out tax, change, payment, loyalty and discount summary lines. Use "." as the decimal separator.`;

function extractJson(text) {
  const s = String(text).replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('cloud_bad_response');
  return JSON.parse(s.slice(a, b + 1));
}

export function normalizeCloud(j) {
  const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const lines = (Array.isArray(j.items) ? j.items : []).map((i) => {
    const quantity = n(i.quantity) > 0 ? n(i.quantity) : 1;
    const lineTotal = n(i.line_total) ?? (n(i.unit_price) !== null ? round2(n(i.unit_price) * quantity) : null);
    const unitPrice = n(i.unit_price) ?? (lineTotal !== null ? round2(lineTotal / quantity) : null);
    return { name: String(i.name ?? '').trim().slice(0, 100), quantity, unitPrice, lineTotal };
  }).filter((l) => l.name);
  return { store: j.store ?? null, date: j.date ?? null, currency: /^[A-Z]{3}$/.test(j.currency ?? '') ? j.currency : null, total: n(j.total), lines };
}

export async function cloudOcr({ provider, apiKey, model, image, mime, fetchImpl = fetch, timeoutMs = 60000 }) {
  const b64 = image.toString('base64');
  const m = model || PROVIDERS[provider]?.model;
  let url, headers, body, pick;
  if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    body = { model: m, max_tokens: 2500, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }, { type: 'text', text: PROMPT }] }] };
    pick = (d) => d.content?.find((c) => c.type === 'text')?.text;
  } else if (provider === 'openai') {
    url = 'https://api.openai.com/v1/chat/completions';
    headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    body = { model: m, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }] };
    pick = (d) => d.choices?.[0]?.message?.content;
  } else if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`;
    headers = { 'x-goog-api-key': apiKey, 'content-type': 'application/json' };
    body = { contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: { responseMimeType: 'application/json' } };
    pick = (d) => d.candidates?.[0]?.content?.parts?.[0]?.text;
  } else throw new Error('unknown_provider');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) throw new Error(`cloud_http_${res.status}`); // never echo the response: it may quote the key or the image
    const text = pick(await res.json());
    if (!text) throw new Error('cloud_bad_response');
    return normalizeCloud(extractJson(text));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('cloud_timeout');
    throw e;
  } finally { clearTimeout(timer); }
}
