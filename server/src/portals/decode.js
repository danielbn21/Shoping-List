import zlib from 'node:zlib';

// Portal files come as gzip or plain XML, in UTF-8 (price files, with a BOM) or UTF-16 LE (some Stores files, with a BOM).
// Returns the XML text with any BOM removed. Zip archives are not handled (the reference plugin does not handle them either).
export function decodeXmlBytes(input) {
  let b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (b.length < 4) throw Object.assign(new Error('empty_file'), { code: 'empty_file' });
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  else if (b[0] === 0x50 && b[1] === 0x4b) throw Object.assign(new Error('zip_archive_not_supported'), { code: 'zip_archive_not_supported' });
  let text;
  if (b[0] === 0xff && b[1] === 0xfe) text = b.subarray(2).toString('utf16le');
  else if (b[0] === 0xfe && b[1] === 0xff) { const sw = Buffer.from(b.subarray(2)); sw.swap16(); text = sw.toString('utf16le'); }
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) text = b.subarray(3).toString('utf8');
  else if (b[0] === 0x3c && b[1] === 0x00) text = b.toString('utf16le'); // UTF-16 LE without a BOM
  else text = b.toString('utf8');
  return text.replace(/^\uFEFF/, '');
}

// What the raw bytes were, for the admin diagnostics screen.
export function describeBytes(input) {
  let b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const parts = [];
  if (b[0] === 0x1f && b[1] === 0x8b) { parts.push('gzip'); try { b = zlib.gunzipSync(b); } catch { return parts.join(' + '); } } else parts.push('plain');
  if (b[0] === 0xff && b[1] === 0xfe) parts.push('UTF-16 LE (BOM)');
  else if (b[0] === 0xfe && b[1] === 0xff) parts.push('UTF-16 BE (BOM)');
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) parts.push('UTF-8 (BOM)');
  else parts.push('UTF-8');
  return parts.join(' + ');
}
