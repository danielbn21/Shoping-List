import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, findMatches, distance } from '../src/match.js';

const bank = (...names) => names.map((name, i) => ({ id: i + 1, name, name_norm: normalize(name) }));

test('English plurals and case collapse to one key', () => {
  for (const v of ['Tomato', 'tomatoes', ' TOMATOES ', 'tomato!']) assert.equal(normalize(v), 'tomato');
  assert.equal(normalize('Strawberries'), normalize('strawberry'));
  assert.equal(normalize('Boxes'), normalize('box'));
  assert.equal(normalize('Glass'), 'glass'); // double-s is not a plural
});

test('Hebrew: niqqud, final letters, plurals and the definite article', () => {
  assert.equal(normalize('תַּפּוּז'), normalize('תפוז'));
  assert.equal(normalize('תפוזים'), normalize('תפוז'));
  assert.equal(normalize('גזרים'), normalize('גזר'));
  assert.equal(normalize('החלב'), normalize('חלב'));
  assert.equal(normalize('מים'), 'מימ'); // short word: plural rule must not strip it
});

test('typo tolerance scales with word length and strictness', () => {
  const b = bank('Rice', 'Cucumber', 'Milk');
  assert.equal(findMatches('Rise', b)[0].item.name, 'Rice');
  assert.equal(findMatches('cucmber', b)[0].item.name, 'Cucumber');
  assert.equal(findMatches('Mlik', b)[0].item.name, 'Milk'); // transposition
  assert.equal(findMatches('Rise', b, { strictness: 'strict' }).length, 0);
  assert.equal(findMatches('Rite', bank('Rice', 'Rye')).length, 1);
});

test('submit-mode ignores prefix hits; typeahead-mode shows them', () => {
  const b = bank('Rice noodles', 'Rice');
  assert.deepEqual(findMatches('rice', b).map((m) => m.kind), ['exact']);
  const t = findMatches('noo', b, { typeahead: true });
  assert.equal(t[0].item.name, 'Rice noodles');
  assert.equal(findMatches('noo', b).length, 0);
});

test('Hebrew typo is caught', () => {
  const b = bank('אורז', 'עגבניות');
  assert.equal(findMatches('אורס', b)[0].item.name, 'אורז');
  assert.equal(findMatches('עגבנייה', b)[0].item.name, 'עגבניות');
  assert.equal(distance('kitten', 'sitting'), 3);
});
