// A tiny synchronous event bus. Core emits facts ("list.deleted"); modules subscribe to clean up their own data.
// A failing listener is logged and never breaks the core request that emitted the event.
export function createEvents(log) {
  const map = new Map();
  return {
    on(name, fn, owner = 'core') {
      if (!map.has(name)) map.set(name, []);
      map.get(name).push({ fn, owner });
      return () => { map.set(name, (map.get(name) || []).filter((l) => l.fn !== fn)); };
    },
    emit(name, payload = {}) {
      for (const l of [...(map.get(name) || [])]) {
        try { const r = l.fn(payload); if (r && typeof r.catch === 'function') r.catch((e) => log?.error?.({ err: e, event: name, module: l.owner }, 'module event handler failed')); }
        catch (e) { log?.error?.({ err: e, event: name, module: l.owner }, 'module event handler failed'); }
      }
    },
    dropOwner(owner) { for (const [k, v] of map) map.set(k, v.filter((l) => l.owner !== owner)); },
  };
}
