import fs from 'node:fs';

// The receipt queue: one receipt at a time, in the background. What reads the photo is whichever enabled module
// provides the 'receipt-reader' capability for the user (see modules/receipt-ocr). The result is stored on the receipt row;
// the review screen and the mandatory confirmation stay in the core.
export function createReceiptQueue(app) {
  const db = app.db;
  const queue = [];
  let busy = false;

  async function process(job) {
    const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(job.receiptId);
    if (!r) return;
    const reader = app.modules.providerFor('receipt-reader', job.userId);
    if (!reader) {
      db.prepare("UPDATE receipts SET ocr_status = 'failed', ocr_error = 'no_reader' WHERE id = ?").run(r.id);
      return;
    }
    try {
      const result = await reader.read({ file: `${app.dataDir}/receipts/${r.file}`, mime: r.mime, userId: job.userId, engine: job.engine });
      db.prepare("UPDATE receipts SET ocr_status = 'done', ocr_engine = ?, ocr_result = ?, ocr_error = NULL WHERE id = ?")
        .run(result.engine ?? null, JSON.stringify(result), r.id);
    } catch (e) {
      db.prepare("UPDATE receipts SET ocr_status = 'failed', ocr_engine = ?, ocr_error = ? WHERE id = ?").run(e.engine ?? null, String(e.message).slice(0, 200), r.id);
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) await process(queue.shift());
    busy = false;
  }

  return {
    enqueue(receiptId, userId, engine) {
      db.prepare("UPDATE receipts SET ocr_status = 'pending', ocr_error = NULL WHERE id = ?").run(receiptId);
      queue.push({ receiptId, userId, engine });
      pump();
    },
    // After a restart, anything still marked pending is picked up again.
    resume() {
      for (const r of db.prepare("SELECT id, uploaded_by FROM receipts WHERE ocr_status = 'pending'").all()) queue.push({ receiptId: r.id, userId: r.uploaded_by });
      pump();
    },
    idle: async () => { while (busy || queue.length) await new Promise((res) => setTimeout(res, 25)); },
  };
}
