import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseReceiptText, hebrewLooksReversed, reverseHebrewRuns, cloudOcr, normalizeCloud } from '../server/ocr.js';
import { findReceiptMatch, normalize } from '../../../server/src/match.js';

const fixture = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'); // real Tesseract 5 output

test('English receipt: lines, quantities and the total are read', () => {
  const r = parseReceiptText(fixture('receipt_en.txt'));
  assert.equal(r.total, 54.1);
  assert.deepEqual(r.lines.map((l) => l.name), ['Milk 3% 1L', 'Bread', 'Tomatoes', 'Cucumbers', 'Rice 9']);
  const cuc = r.lines.find((l) => l.name === 'Cucumbers');
  assert.deepEqual([cuc.quantity, cuc.unitPrice, cuc.lineTotal], [2, 4.5, 9]); // "2 x 4.50  9.00"
});

test('Hebrew receipt: reversed visual order is detected and repaired, total found', () => {
  const text = fixture('receipt_he.txt');
  assert.equal(hebrewLooksReversed(text), true);
  const r = parseReceiptText(text);
  assert.equal(r.total, 67.1);
  assert.deepEqual(r.lines.map((l) => l.name).slice(0, 4), ['3% חלב', 'לחם אחיד', 'עגבניות', 'אורז בסמטי']);
  assert.deepEqual(r.lines.map((l) => l.lineTotal).slice(0, 4), [7.9, 12.5, 9.8, 14.9]);
  assert.equal(reverseHebrewRuns('םחל'), 'לחם');
  assert.equal(hebrewLooksReversed('חלב ולחם'), false); // correct order: final letters at the ends
});

test('receipt lines match bank items by words, in either Hebrew direction', () => {
  const bank = ['Milk', 'Bread', 'Rice noodles', 'Rice'].map((name, id) => ({ id, name, name_norm: normalize(name) }));
  assert.equal(findReceiptMatch('Milk 3% 1L', bank).name, 'Milk');
  assert.equal(findReceiptMatch('RICE NOODLES 500G', bank).name, 'Rice noodles'); // longest explanation wins
  assert.equal(findReceiptMatch('Rice 1kg', bank).name, 'Rice');
  assert.equal(findReceiptMatch('Cheese', bank), null);
  const he = ['חלב', 'לחם'].map((name, id) => ({ id, name, name_norm: normalize(name) }));
  assert.equal(findReceiptMatch('3% חלב', he).name, 'חלב'); // word order on the receipt does not matter
});

test('cloud providers: request shape, JSON parsing, and the key never leaks into errors', async () => {
  const payload = { store: 'Shufersal', date: '2026-10-30', currency: 'ILS', total: '23.7', items: [{ name: 'חלב', quantity: 3, unit_price: 7.9 }, { name: 'Bread', line_total: 12.5 }] };
  const calls = [];
  const fake = (reply) => async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => reply }; };
  const img = Buffer.from('fake-image');

  let r = await cloudOcr({ provider: 'anthropic', apiKey: 'sk-ant-SECRET', image: img, mime: 'image/jpeg', fetchImpl: fake({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' }] }) });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-SECRET');
  assert.equal(JSON.parse(calls[0].init.body).messages[0].content[0].source.media_type, 'image/jpeg');
  assert.equal(r.total, 23.7);
  assert.deepEqual(r.lines[0], { name: 'חלב', quantity: 3, unitPrice: 7.9, lineTotal: 23.7 }); // derived line total
  assert.deepEqual(r.lines[1], { name: 'Bread', quantity: 1, unitPrice: 12.5, lineTotal: 12.5 });

  r = await cloudOcr({ provider: 'openai', apiKey: 'sk-oa', image: img, mime: 'image/png', fetchImpl: fake({ choices: [{ message: { content: JSON.stringify(payload) } }] }) });
  assert.match(calls[1].url, /api\.openai\.com/);
  assert.equal(calls[1].init.headers.authorization, 'Bearer sk-oa');
  assert.match(JSON.parse(calls[1].init.body).messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(r.currency, 'ILS');

  r = await cloudOcr({ provider: 'gemini', apiKey: 'g-key', model: 'gemini-x', image: img, mime: 'image/webp', fetchImpl: fake({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) });
  assert.match(calls[2].url, /models\/gemini-x:generateContent$/);
  assert.equal(calls[2].init.headers['x-goog-api-key'], 'g-key'); // header, not in the URL
  assert.equal(r.lines.length, 2);

  await assert.rejects(cloudOcr({ provider: 'openai', apiKey: 'sk-LEAKME', image: img, mime: 'image/jpeg', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'bad key sk-LEAKME' }) }) }),
    (e) => e.message === 'cloud_http_401' && !e.message.includes('LEAKME'));
  await assert.rejects(cloudOcr({ provider: 'nope', apiKey: 'x', image: img, mime: 'image/jpeg' }), /unknown_provider/);
  assert.deepEqual(normalizeCloud({ items: [{ name: '' }, { name: 'X', quantity: 'abc' }] }).lines, [{ name: 'X', quantity: 1, unitPrice: null, lineTotal: null }]);
});
