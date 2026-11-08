import fs from 'node:fs';
import path from 'node:path';
import { decodeXmlBytes, describeBytes } from './decode.js';
import { parseStoresXml, headerOf, iterItems } from './xml.js';
import { normalizeUnit, tidyUnit } from './units.js';

const safe = (s) => String(s).replace(/[^\w.\-]/g, '_').slice(0, 120);

// A dry run over one PriceFull file: how many items, how they are coded and priced, which unit spellings are unknown.
export function summarizePriceFile(xml) {
  const head = headerOf(xml);
  const units = new Map(), unknown = new Map();
  let items = 0, weighted = 0, internal = 0, barcodes = 0, shortCodes = 0, qtyZero = 0, badPrice = 0, deposits = 0, noUnit = 0;
  const seen = new Set();
  let dupes = 0;
  for (const it of iterItems(xml)) {
    items++;
    const code = it.itemcode || '';
    if (seen.has(code)) dupes++; else seen.add(code);
    if (it.bisweighted === '1') weighted++;
    if (it.itemtype === '0') internal++;
    if (/^\d{8,13}$/.test(code) && it.itemtype !== '0') barcodes++;
    if (!/^\d{8,13}$/.test(code)) shortCodes++;
    if (['', '0', '0.00'].includes(it.quantity ?? '')) qtyZero++;
    if (!/^\d+(\.\d+)?$/.test(it.itemprice ?? '')) badPrice++;
    if (/פיקדון|בקבוק חוזר/.test(it.itemname ?? '')) deposits++;
    const u = tidyUnit(it.unitofmeasure);
    units.set(u, (units.get(u) || 0) + 1);
    const nu = normalizeUnit(u);
    if (!nu) unknown.set(u, (unknown.get(u) || 0) + 1);
    else if (nu.unit === 'unspecified') noUnit++;
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([unit, count]) => ({ unit, count }));
  return {
    chainId: head.chainid || '', subChainId: head.subchainid || '', storeId: head.storeid || '',
    items, weighted, internalCodes: internal, barcodes, shortCodes, qtyZero, badPrice, deposits, duplicates: dupes, noUnit,
    units: top(units, 12), unknownUnits: top(unknown, 12),
  };
}

export function summarizeStores(xml) {
  const p = parseStoresXml(xml);
  const cities = new Set(p.stores.map((s) => s.city).filter(Boolean));
  const numeric = p.stores.filter((s) => /^\d+$/.test(s.city)).length;
  return {
    chainId: p.chainId, chainName: p.chainName, updated: p.updated, branches: p.stores.length, cities: cities.size,
    cityCodes: numeric === p.stores.length ? 'numeric codes' : numeric ? 'mixed codes and names' : 'names',
    zipFilled: p.stores.filter((s) => s.zip && !/^0+$/.test(s.zip)).length, sample: p.stores[0] ?? null,
  };
}

// Admin "Test portal": log in, read the Stores file, find a PriceFull file for a branch, parse it. Every step reports time and outcome.
export async function runPortalTest({ chain, portals, storeId, save, dataDir, pickBranch, now = Date.now }) {
  const report = { chain: chain.id, startedAt: now(), steps: [], files: {}, saved: [] };
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { const detail = await fn(); report.steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? null }); return true; }
    catch (e) { report.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message || e), code: e?.code || null }); return false; }
  };
  let access, stores, storesFile, branches = [];
  const keep = (file, bytes) => {
    if (!save) return;
    const dir = path.join(dataDir, 'portal-samples', safe(chain.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safe(file)), bytes);
    report.saved.push(safe(file));
  };

  if (!(await step('open', async () => { access = portals.open(chain); return access.probe(); }))) return report;
  if (await step('stores', async () => {
    const f = await access.stores();
    storesFile = f;
    keep(f.name, f.bytes);
    report.files.stores = f.files.map((x) => ({ name: x.name, size: x.size ?? null, time: x.time ?? null }));
    const xml = decodeXmlBytes(f.bytes);
    stores = parseStoresXml(xml);
    return { file: f.name, bytes: f.bytes.length, format: describeBytes(f.bytes), ...summarizeStores(xml) };
  })) branches = stores.stores;

  if (!branches.length) return report;
  // Try the requested branch, else a few branches, until one has a PriceFull file today.
  const candidates = storeId ? [String(storeId)] : (pickBranch ? pickBranch(branches) : branches.map((b) => b.storeId)).slice(0, 4);
  let found = null;
  await step('pricefull_list', async () => {
    const tried = [];
    for (const id of candidates) {
      const list = await access.priceFullList(id);
      tried.push({ storeId: id, files: list.length });
      if (list.length) { found = { id, list }; break; }
    }
    report.files.rawKeys = access.rawKeys ?? null;
    if (!found) throw Object.assign(new Error(`no PriceFull file for branch(es) ${candidates.join(', ')} (closed today / Shabbat?)`), { code: 'no_pricefull' });
    report.files.priceFull = found.list.slice(0, 6).map((x) => ({ name: x.name, size: x.size ?? null, time: x.time ?? null }));
    return { branch: found.id, tried };
  });
  if (!found) return report;

  await step('pricefull_parse', async () => {
    const f = await access.priceFull(found.id);
    keep(f.name, f.bytes);
    const xml = decodeXmlBytes(f.bytes);
    return { file: f.name, bytes: f.bytes.length, format: describeBytes(f.bytes), ...summarizePriceFile(xml) };
  });
  report.finishedAt = now();
  return report;
}

export const samplesDir = (dataDir) => path.join(dataDir, 'portal-samples');
export const listSamples = (dataDir) => {
  const root = samplesDir(dataDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) =>
    fs.readdirSync(path.join(root, d.name)).map((f) => ({ chain: d.name, file: f, size: fs.statSync(path.join(root, d.name, f)).size })));
};
