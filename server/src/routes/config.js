// Checkpoints and files of the admin configuration (1.9.0). What a snapshot holds is described in config.js; the SMTP password is never in one.
const bad = (reply, error, code = 400) => reply.code(code).send({ error });

export default async function configRoutes(app) {
  const pre = { preHandler: app.auth({ admin: true }) };
  const file = (reply, name, data) => reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).send(JSON.stringify(data, null, 2));
  const day = () => new Date().toISOString().slice(0, 10);

  app.get('/api/admin/config/checkpoints', pre, async () => ({ checkpoints: app.config.list() }));

  app.post('/api/admin/config/checkpoints', pre, async (req) => ({ id: app.config.save((req.body || {}).name, req.user.id) }));

  app.delete('/api/admin/config/checkpoints/:id', pre, async (req, reply) => (app.config.remove(req.params.id) ? { ok: true } : bad(reply, 'not_found', 404)));

  // the configuration as it is now, or one checkpoint, as a file
  app.get('/api/admin/config/export', pre, async (req, reply) => file(reply, `shoplist-config-${day()}.json`, app.config.snapshot()));
  app.get('/api/admin/config/checkpoints/:id/export', pre, async (req, reply) => {
    const data = app.config.get(req.params.id);
    return data ? file(reply, `shoplist-config-checkpoint-${req.params.id}.json`, data) : bad(reply, 'not_found', 404);
  });

  // What a restore would change (nothing is changed): from a checkpoint ({ checkpointId }) or from the contents of a file ({ data }).
  const source = (b) => {
    if (b.checkpointId !== undefined) { const d = app.config.get(b.checkpointId); return d ? { data: d } : { error: 'not_found', status: 404 }; }
    return b.data && typeof b.data === 'object' ? { data: b.data } : { error: 'not_a_config_file' };
  };
  const view = (p) => ({ changes: p.changes, skipped: p.skipped, warnings: p.warnings });

  app.post('/api/admin/config/preview', pre, async (req, reply) => {
    const src = source(req.body || {});
    if (src.error) return bad(reply, src.error, src.status ?? 400);
    const p = app.config.plan(src.data);
    return p.error ? bad(reply, p.error) : view(p);
  });

  app.post('/api/admin/config/restore', pre, async (req, reply) => {
    const src = source(req.body || {});
    if (src.error) return bad(reply, src.error, src.status ?? 400);
    const p = app.config.plan(src.data);
    if (p.error) return bad(reply, p.error);
    if (!p.changes.length) return { ...view(p), restorePointId: null, failed: [] };   // nothing to change: nothing is saved
    const r = app.config.apply(p, req.user.id);
    return { ...view(p), ...r };
  });
}
