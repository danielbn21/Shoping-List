// A small reader for the portals' flat XML (no nesting inside Item or Store, tag names compared case-insensitively).
// Hand-written on purpose: the files are regular, and it keeps the server free of an XML dependency.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function unescapeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, c) => c)
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e[0] === '#') { const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENT[e];
    });
}

// <A>1</A><B/> -> { a: '1', b: '' }   (keys lower-cased)
export function fieldsOf(inner) {
  const out = {};
  const re = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = unescapeXml((m[2] ?? '').trim());
  return out;
}

export function* blocks(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml))) yield m[1];
}

// Everything in <Root> before the item/sub-chain lists: ChainID, SubChainID, StoreID, BikoretNo, LastUpdateDate...
export function headerOf(xml) {
  const cut = xml.search(/<(Items|SubChains)[\s>]/i);
  const head = (cut < 0 ? xml : xml.slice(0, cut)).replace(/^[\s\S]*?<Root(?:\s[^>]*)?>/i, '').replace(/<\/Root>\s*$/i, '');
  return fieldsOf(head);
}

export function* iterItems(xml) {
  for (const inner of blocks(xml, 'Item')) yield fieldsOf(inner);
}

const stripZeros = (s) => (s || '').replace(/^0+(?=\d)/, '');

// Stores file -> { chainId, chainName, updated, stores: [{ storeId, storeIdRaw, name, address, city, zip, storeType, subChainId, subChainName }] }
// The sub-chain id/name sit on the parent <SubChain>, not inside <Store> (the reference plugin misses this).
export function parseStoresXml(xml) {
  const head = headerOf(xml);
  const stores = [];
  const push = (inner, sub) => {
    const f = fieldsOf(inner);
    if (!f.storeid) return;
    stores.push({
      storeId: stripZeros(f.storeid), storeIdRaw: f.storeid, name: f.storename || '', address: f.address || '', city: f.city || '',
      zip: f.zipcode || '', storeType: f.storetype || '', subChainId: f.subchainid || sub.id, subChainName: f.subchainname || sub.name,
    });
  };
  let any = false;
  for (const sc of blocks(xml, 'SubChain')) {
    any = true;
    const pre = sc.search(/<Stores[\s>]/i);
    const sf = fieldsOf(pre < 0 ? sc : sc.slice(0, pre));
    for (const st of blocks(sc, 'Store')) push(st, { id: sf.subchainid || '', name: sf.subchainname || '' });
  }
  if (!any) for (const st of blocks(xml, 'Store')) push(st, { id: '', name: '' });
  return { chainId: head.chainid || '', chainName: head.chainname || '', updated: [head.lastupdatedate, head.lastupdatetime].filter(Boolean).join(' '), stores };
}
