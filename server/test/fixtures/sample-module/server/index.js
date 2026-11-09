import fs from 'node:fs';

export const migrations = ['CREATE TABLE notes (id INTEGER PRIMARY KEY, list_id INTEGER, text TEXT);'];

export default function register(ctx) {
  ctx.provide('greeter', { hello: (name) => `hello ${name}` });
  ctx.routes.get('/ping', async (req) => ({ pong: true, user: req.user.username, version: ctx.version }));
  ctx.routes.get('/admin-only', { access: 'admin' }, async () => ({ secret: true }));
  ctx.routes.post('/notes', async (req) => { ctx.db.prepare('INSERT INTO notes(list_id, text) VALUES (?,?)').run(req.body.listId, req.body.text); return { ok: true }; });
  ctx.routes.get('/notes', async () => ({ notes: ctx.db.prepare('SELECT list_id, text FROM notes').all() }));
  ctx.routes.get('/listaccess/:id', async (req, reply) => { const a = ctx.core.listAccess(req.user, req.params.id); return a ? { role: a.role } : reply.code(404).send({ error: 'not_found' }); });
  ctx.routes.get('/file', async () => { fs.writeFileSync(`${ctx.filesDir}/x.txt`, 'x'); return { ok: true }; });
  ctx.events.on('list.deleted', ({ listId }) => ctx.db.prepare('DELETE FROM notes WHERE list_id = ?').run(listId));
  ctx.settings.set('boots', (ctx.settings.get('boots', 0) || 0) + 1);
}
