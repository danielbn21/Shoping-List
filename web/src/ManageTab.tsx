import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  DndContext, closestCenter, getFirstCollision, pointerWithin, rectIntersection, useDroppable,
  type CollisionDetection, type DragEndEvent, type DragOverEvent, type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { api, ApiError } from './api';
import { t, errText, getLang, timeAgo } from './i18n';
import { catName, fmt } from './util';
import { SortableList, SortableRow, useDndSensors } from './dnd';
import type { Cat, Detail, Entry, Me, PastItem, Store } from './types';
import { useSlots } from './slots';

type Props = { data: Detail; me: Me; reload: () => Promise<void>; onDeleted: () => void };

// The active screen: everything that changes what is on the list or how it is organised.
export default function ManageTab({ data, me, reload, onDeleted }: Props) {
  const isOwner = data.list.role === 'owner';
  const moduleSections = useSlots('manage.section', { me, data }); // sections added by modules
  return (
    <div className="stack">
      <AddItem data={data} reload={reload} />
      <OnThisList data={data} reload={reload} />
      <PastItems data={data} reload={reload} />
      <Collapsible title={t('csvTitle')}><CsvCard data={data} reload={reload} /></Collapsible>
      <Collapsible title={t('categoriesOrder')}><CategoriesCard data={data} reload={reload} /></Collapsible>
      <Collapsible title={t('stores')}><StoresCard data={data} reload={reload} /></Collapsible>
      {moduleSections.map((m) => <Collapsible key={`${m.moduleId}:${m.id}`} title={m.title()}><m.component data={data} me={me} reload={reload} /></Collapsible>)}
      {isOwner && <Collapsible title={t('people')}><PeopleCard data={data} /></Collapsible>}
      {isOwner && <Collapsible title={t('listNameLabel')}><ListSettings data={data} reload={reload} onDeleted={onDeleted} /></Collapsible>}
    </div>
  );
}

function Collapsible({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="card">
      <summary style={{ fontWeight: 800, cursor: 'pointer', minHeight: 32, fontSize: '1.1rem' }}>{title}</summary>
      <div className="stack-sm" style={{ marginTop: 12 }}>{children}</div>
    </details>
  );
}

function Stepper({ value, onChange, min = 1 }: { value: number; onChange: (n: number) => void; min?: number }) {
  return (
    <div className="qty">
      <button type="button" aria-label={t('fewer')} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <output>{fmt(value)}</output>
      <button type="button" aria-label={t('more')} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

/* ---------------- add a new item ---------------- */

function AddItem({ data, reload }: { data: Detail; reload: () => Promise<void> }) {
  const { list, categories } = data;
  const [q, setQ] = useState('');
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');
  const [catId, setCatId] = useState('');
  const [newCat, setNewCat] = useState('');
  const [sugg, setSugg] = useState<PastItem[]>([]);
  const [similar, setSimilar] = useState<{ id: number; name: string }[] | null>(null);
  const [error, setError] = useState('');
  const creatingCat = catId === '__new__';

  useEffect(() => {
    setSimilar(null);
    const text = q.trim();
    if (!text) { setSugg([]); return; }
    let stale = false;
    const id = setTimeout(async () => {
      try {
        const r = await api<{ items: PastItem[] }>(`/households/${list.householdId}/items?q=${encodeURIComponent(text)}&mode=typeahead&listId=${list.id}`);
        if (!stale) setSugg(r.items);
      } catch { /* suggestions are optional */ }
    }, 150);
    return () => { stale = true; clearTimeout(id); };
  }, [q, list.householdId, list.id]);

  const reset = () => { setQ(''); setQty('1'); setNote(''); setCatId(''); setNewCat(''); setSugg([]); setSimilar(null); setError(''); };

  async function createCategory() {
    const name = newCat.trim();
    if (!name) return;
    try {
      const r = await api<{ id: number }>(`/households/${list.householdId}/categories`, { method: 'POST', body: getLang() === 'he' ? { nameHe: name } : { nameEn: name } });
      await reload();
      setCatId(String(r.id)); setNewCat('');
    } catch (e) { setError(errText(e)); }
  }

  async function post(extra: Record<string, unknown>) {
    setError('');
    try {
      await api(`/lists/${list.id}/entries`, {
        method: 'POST',
        body: { quantity: Number(qty) || 1, note: note || undefined, categoryId: catId && !creatingCat ? Number(catId) : undefined, ...extra },
      });
      reset(); await reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'similar_items') setSimilar(e.body?.matches ?? []);
      else setError(errText(e));
    }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); if (q.trim() && !creatingCat) post({ name: q.trim() }); };
  const name = q.trim();

  return (
    <form className="card stack-sm" onSubmit={submit}>
      <h2>{t('addItems')}</h2>
      <label className="field"><span>{t('itemLabel')}</span>
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('addItemPlaceholder')} autoComplete="off" enterKeyHint="done" style={{ minHeight: 52, fontSize: '1.05rem' }} />
      </label>

      {similar && (
        <div className="suggest" role="alert">
          <p style={{ fontWeight: 700 }}>{t('didYouMean')}</p>
          {similar.map((m) => <button type="button" className="similar" key={m.id} onClick={() => post({ itemId: m.id, source: 'typeahead' })}>{m.name}</button>)}
          <button type="button" className="new" onClick={() => post({ name, force: true })}>{t('addAsNew', { name })}</button>
        </div>
      )}
      {!similar && name && sugg.length > 0 && (
        <div className="suggest">
          {sugg.map((s) => (
            <button type="button" key={s.id} onClick={() => post({ itemId: s.id, source: 'typeahead' })}>
              <span>{s.name}</span>
              {s.onListQty > 0 && <span className="chip warn">{t('onListQty', { n: fmt(s.onListQty) })}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'nowrap' }}>
        <label className="field" style={{ width: 96 }}><span>{t('quantityLabel')}</span>
          <input type="number" inputMode="decimal" min="0.01" step="any" value={qty} onChange={(e) => setQty(e.target.value)} dir="ltr" style={{ textAlign: 'center' }} />
        </label>
        <button className="btn primary grow" type="submit" disabled={!name || creatingCat} style={{ minHeight: 46 }}>{t('add')}</button>
      </div>

      <label className="field"><span>{t('categoryLabel')}</span>
        <select value={catId} onChange={(e) => setCatId(e.target.value)}>
          <option value="">{t('uncategorized')}</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{catName(c)}</option>)}
          <option value="__new__">{t('newCategoryOption')}</option>
        </select>
      </label>
      {creatingCat && (
        <div className="inline-form">
          <input type="text" autoFocus value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder={t('newCategoryName')} aria-label={t('newCategoryName')}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createCategory(); } }} />
          <button type="button" className="btn" onClick={createCategory} disabled={!newCat.trim()}>{t('createCategory')}</button>
        </div>
      )}
      <label className="field"><span>{t('noteLabel')}</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

/* ---------------- what is on the list: reorder + re-file by drag and drop ---------------- */

type Layout = Record<string, number[]>;

function Group({ id, title, count, show, children }: { id: string; title: string; count: number; show: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  if (!show) return null;
  return (
    <section ref={setNodeRef} className={`group${isOver ? ' over' : ''}`}>
      <div className="section-title"><span>{title}</span><span>{count}</span></div>
      <div className="group-body">{children}</div>
    </section>
  );
}

function OnThisList({ data, reload }: { data: Detail; reload: () => Promise<void> }) {
  const { entries, categories, list } = data;
  const open = entries.filter((e) => e.state === 'open');
  const byId = new Map(open.map((e) => [e.id, e]));
  const known = new Set(categories.map((c) => c.id));
  const keyOf = (e: Entry) => (e.categoryId !== null && known.has(e.categoryId) ? `c:${e.categoryId}` : 'none');
  const keys = [...categories.map((c) => `c:${c.id}`), 'none'];
  const build = (): Layout => {
    const m: Layout = {};
    keys.forEach((k) => { m[k] = []; });
    [...open].sort((a, b) => a.position - b.position || a.id - b.id).forEach((e) => m[keyOf(e)].push(e.id));
    return m;
  };

  const [layout, setLayout] = useState<Layout>(build);
  const [dragging, setDragging] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const sensors = useDndSensors();

  const sig = JSON.stringify([open.map((e) => [e.id, e.categoryId, e.position, e.quantity, e.note]), categories.map((c) => c.id)]);
  useEffect(() => { if (!dragging) setLayout(build()); /* eslint-disable-next-line */ }, [sig]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Find the group under the pointer, then the nearest row inside it, so rows can be reordered
  // within a group and dropped into any other group (including empty ones).
  const collision: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    const found = hits.length ? hits : rectIntersection(args);
    let overId = getFirstCollision(found, 'id');
    if (overId == null) return [];
    const l = layoutRef.current;
    if (typeof overId === 'string' && overId in l && l[overId].length) {
      const inside = args.droppableContainers.filter((c) => l[overId as string].includes(c.id as number));
      const nearest = closestCenter({ ...args, droppableContainers: inside });
      if (nearest.length) overId = nearest[0].id;
    }
    return [{ id: overId }];
  };

  const find = (id: UniqueIdentifier, l: Layout) => (typeof id === 'string' && id in l ? id : Object.keys(l).find((k) => l[k].includes(id as number)));

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    setLayout((prev) => {
      const from = find(active.id, prev), to = find(over.id, prev);
      if (!from || !to || from === to) return prev;
      const target = prev[to];
      let index: number;
      if (over.id in prev) index = target.length;
      else {
        const overIndex = target.indexOf(over.id as number);
        const t0 = active.rect.current.translated;
        const below = !!t0 && t0.top > over.rect.top + over.rect.height / 2;
        index = overIndex + (below ? 1 : 0);
      }
      return { ...prev, [from]: prev[from].filter((i) => i !== active.id), [to]: [...target.slice(0, index), active.id as number, ...target.slice(index)] };
    });
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    setDragging(false);
    let next = layout;
    const from = find(active.id, layout);
    const to = over ? find(over.id, layout) : undefined;
    if (from && to && from === to && over && !(over.id in layout)) {
      const i = layout[from].indexOf(active.id as number);
      const j = layout[to].indexOf(over.id as number);
      if (i !== j && j >= 0) { next = { ...layout, [to]: arrayMove(layout[to], i, j) }; setLayout(next); }
    }
    if (JSON.stringify(next) === JSON.stringify(build())) return;
    try {
      await api(`/lists/${list.id}/reorder`, {
        method: 'POST',
        body: { groups: keys.map((k) => ({ categoryId: k === 'none' ? null : Number(k.slice(2)), entryIds: next[k] })) },
      });
    } catch (e) { setError(errText(e)); }
    await reload();
  };

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await reload(); } catch (e) { setError(errText(e)); }
  };

  return (
    <section className="card stack-sm">
      <h2>{t('onThisList')}</h2>
      <p className="muted">{t('manageHint')}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {open.length === 0 && !dragging && <p className="muted">{t('emptyManage')}</p>}
      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={() => setDragging(true)} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setDragging(false); setLayout(build()); }}>
        {keys.map((k) => {
          const cat: Cat | undefined = k === 'none' ? undefined : categories.find((c) => `c:${c.id}` === k);
          const ids = layout[k] ?? [];
          return (
            <Group key={k} id={k} title={cat ? catName(cat) : t('uncategorized')} count={ids.length} show={ids.length > 0 || dragging}>
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {ids.map((id) => {
                  const e = byId.get(id);
                  if (!e) return null;
                  const editing = editId === id;
                  return (
                    <SortableRow key={id} id={id} className="entry manage">
                      {(handle) => (
                        <>
                          {handle}
                          <div className="grow">
                            <div className="name">{e.name}</div>
                            {e.note && !editing && <div className="muted">{e.note}</div>}
                          </div>
                          <div className="ctrls">
                            <Stepper value={e.quantity} onChange={(n) => run(() => api(`/entries/${e.id}`, { method: 'PATCH', body: { quantity: n } }))} />
                            <button type="button" className="iconbtn" aria-label={t('editItem')} aria-expanded={editing} onClick={() => setEditId(editing ? null : id)}>✎</button>
                            <button type="button" className="iconbtn danger" aria-label={t('removeItem')} title={t('removeItem')}
                              onClick={() => run(() => api(`/entries/${e.id}`, { method: 'DELETE' }))}>✕</button>
                          </div>
                          {editing && (
                            <div className="edit-panel">
                              <label className="field"><span>{t('noteLabel')}</span>
                                <input type="text" defaultValue={e.note ?? ''}
                                  onBlur={(ev) => { if (ev.target.value !== (e.note ?? '')) run(() => api(`/entries/${e.id}`, { method: 'PATCH', body: { note: ev.target.value } })); }} /></label>
                              <label className="field"><span>{t('categoryLabel')}</span>
                                <select value={e.categoryId ?? ''} onChange={(ev) => run(() => api(`/entries/${e.id}`, { method: 'PATCH', body: { categoryId: ev.target.value ? Number(ev.target.value) : null } }))}>
                                  <option value="">{t('uncategorized')}</option>
                                  {categories.map((c) => <option key={c.id} value={c.id}>{catName(c)}</option>)}
                                </select></label>
                            </div>
                          )}
                        </>
                      )}
                    </SortableRow>
                  );
                })}
              </SortableContext>
            </Group>
          );
        })}
      </DndContext>
    </section>
  );
}

/* ---------------- add again from what was bought or used before ---------------- */

function PastItems({ data, reload }: { data: Detail; reload: () => Promise<void> }) {
  const { list, categories } = data;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [items, setItems] = useState<PastItem[] | null>(null);
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: PastItem[] }>(`/households/${list.householdId}/items?listId=${list.id}&sort=${sort}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`);
      setItems(r.items);
    } catch { /* offline */ }
  }, [list.householdId, list.id, sort, q]);
  useEffect(() => { const id = setTimeout(load, 150); return () => clearTimeout(id); }, [load]);
  const listSig = data.entries.map((e) => `${e.itemId}:${e.quantity}:${e.state}`).join();
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [listSig]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await reload(); await load(); } catch (e) { setError(errText(e)); }
  };
  const shown = (items ?? []).filter((i) => (filter === '' ? true : filter === 'none' ? i.categoryId === null : i.categoryId === Number(filter)));

  return (
    <section className="card stack-sm">
      <div><h2>{t('fromHistory')}</h2><p className="muted">{t('pastHelp')}</p></div>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchBank')} aria-label={t('searchBank')} style={{ minHeight: 48 }} />
      <div className="row">
        <select className="grow" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('categoryLabel')}>
          <option value="">{t('allCategories')}</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{catName(c)}</option>)}
          <option value="none">{t('uncategorized')}</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'name')} aria-label={t('sortName')}>
          <option value="recent">{t('sortRecent')}</option>
          <option value="name">{t('sortName')}</option>
        </select>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {items && !shown.length && <p className="muted">{t('bankEmpty')}</p>}
      <div>
        {shown.map((i) => {
          const n = qtys[i.id] ?? 1;
          const open = editing === i.id;
          const caption = i.timesPurchased > 0 ? t('boughtShort', { n: i.timesPurchased, when: timeAgo(i.lastPurchasedAt) }) : t('neverBought');
          const full = [i.onListQty > 0 ? t('onListQty', { n: fmt(i.onListQty) }) : '',
            i.timesPurchased > 0 ? `${t('boughtTimes', { n: i.timesPurchased })} · ${t('lastBought', { when: timeAgo(i.lastPurchasedAt) })}` : t('neverBought')].filter(Boolean).join(' · ');
          return (
            <div className="past" key={i.id}>
              <div className="past-row">
                <div className="past-name" title={`${i.name} · ${full}`}>
                  <span className="past-top">
                    <strong>{i.name}</strong>
                    {i.onListQty > 0 && <span className="onlist" aria-label={t('onListQty', { n: fmt(i.onListQty) })}>×{fmt(i.onListQty)}</span>}
                  </span>
                  <small className="muted">{caption}</small>
                </div>
                <Stepper value={n} onChange={(v) => setQtys({ ...qtys, [i.id]: v })} />
                <button className="btn small primary" aria-label={t('addToList')} onClick={() => run(async () => {
                  await api(`/lists/${list.id}/entries`, { method: 'POST', body: { itemId: i.id, quantity: n, source: 'typeahead' } });
                  setQtys({ ...qtys, [i.id]: 1 });
                })}>{t('add')}</button>
                <button className="iconbtn" aria-label={t('editItem')} aria-expanded={open} onClick={() => setEditing(open ? null : i.id)}>✎</button>
                <button className="iconbtn danger" aria-label={t('removeFromBank')} title={t('removeFromBank')}
                  onClick={() => { if (confirm(t('confirmRemoveBank', { name: i.name }))) run(() => api(`/items/${i.id}`, { method: 'DELETE' })); }}>✕</button>
              </div>
              {open && <ItemEditor item={i} categories={categories} onCancel={() => setEditing(null)} onSaved={async () => { await reload(); await load(); setEditing(null); }} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Edit what the bank remembers about an item: its name, category, default note and an optional price.
function ItemEditor({ item, categories, onSaved, onCancel }: { item: PastItem; categories: Cat[]; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(item.name);
  const [cat, setCat] = useState(item.categoryId === null ? '' : String(item.categoryId));
  const [note, setNote] = useState(item.defaultNote ?? '');
  const [price, setPrice] = useState(item.price === null ? '' : String(item.price));
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    try {
      await api(`/items/${item.id}`, { method: 'PATCH', body: { name, categoryId: cat ? Number(cat) : null, defaultNote: note, price: price === '' ? null : Number(price) } });
      onSaved();
    } catch (err) { setError(errText(err)); }
  }
  return (
    <form className="edit-panel past-edit" onSubmit={submit}>
      <label className="field"><span>{t('itemLabel')}</span>
        <input type="text" required value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>{t('categoryLabel')}</span>
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">{t('uncategorized')}</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{catName(c)}</option>)}
        </select></label>
      <label className="field"><span>{t('defaultNote')}</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        <span className="muted" style={{ fontWeight: 400 }}>{t('itemEditorHint')}</span></label>
      <label className="field"><span>{t('priceOptional')}</span>
        <input type="number" inputMode="decimal" min="0" step="0.01" dir="ltr" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="btn small primary" type="submit">{t('save')}</button>
        <button className="btn small" type="button" onClick={onCancel}>{t('cancel')}</button>
      </div>
    </form>
  );
}

/* ---------------- categories: order, rename, add, delete ---------------- */

function CategoriesCard({ data, reload }: { data: Detail; reload: () => Promise<void> }) {
  const hid = data.list.householdId;
  const [cats, setCats] = useState<Cat[]>(data.categories);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  useEffect(() => setCats(data.categories), [data.categories]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await reload(); } catch (e) { setError(errText(e)); await reload(); }
  };
  const he = getLang() === 'he';

  return (
    <>
      <p className="muted">{t('categoriesHelp')}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <SortableList items={cats} onReorder={(next) => { setCats(next); run(() => api(`/households/${hid}/categories/order`, { method: 'PUT', body: { ids: next.map((c) => c.id) } })); }}
        render={(c, handle) => (
          <>
            {handle}
            {renaming === c.id ? (
              <form className="inline-form grow" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/categories/${c.id}`, { method: 'PATCH', body: he ? { nameHe: text } : { nameEn: text } }); setRenaming(null); }); }}>
                <input type="text" autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label={t('rename')} />
                <button className="btn small" type="submit">{t('save')}</button>
              </form>
            ) : (
              <>
                <span className="grow">{catName(c)}</span>
                <button type="button" className="iconbtn" aria-label={t('rename')} title={t('rename')} onClick={() => { setRenaming(c.id); setText(catName(c)); }}>✎</button>
                <button type="button" className="iconbtn danger" aria-label={t('removeItem')} title={t('removeItem')}
                  onClick={() => { if (confirm(t('confirmDeleteCategory', { name: catName(c) }))) run(() => api(`/categories/${c.id}`, { method: 'DELETE' })); }}>✕</button>
              </>
            )}
          </>
        )} />
      <form className="inline-form" onSubmit={(e) => {
        e.preventDefault();
        if (!newName.trim()) return;
        run(async () => { await api(`/households/${hid}/categories`, { method: 'POST', body: he ? { nameHe: newName } : { nameEn: newName } }); setNewName(''); });
      }}>
        <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('newCategoryName')} aria-label={t('newCategoryName')} />
        <button className="btn small" type="submit">{t('addCategory')}</button>
      </form>
    </>
  );
}

/* ---------------- stores: a walking order of categories per supermarket ---------------- */

function StoreLayout({ store, categories, reload }: { store: Store; categories: Cat[]; reload: () => Promise<void> }) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const base = () => [...store.categoryOrder.filter((id) => byId.has(id)), ...categories.map((c) => c.id).filter((id) => !store.categoryOrder.includes(id))].map((id) => byId.get(id)!);
  const [order, setOrder] = useState<Cat[]>(base);
  useEffect(() => { setOrder(base()); /* eslint-disable-next-line */ }, [store.categoryOrder.join(), categories.map((c) => c.id).join()]);
  return (
    <SortableList items={order}
      onReorder={async (next) => { setOrder(next); await api(`/stores/${store.id}/layout`, { method: 'PUT', body: { categoryIds: next.map((c) => c.id) } }); await reload(); }}
      render={(c, handle) => <>{handle}<span className="grow">{catName(c)}</span></>} />
  );
}

function StoresCard({ data, reload }: { data: Detail; reload: () => Promise<void> }) {
  const hid = data.list.householdId;
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await reload(); } catch (e) { setError(errText(e)); }
  };
  return (
    <>
      <p className="muted">{t('storesHelp')}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data.stores.map((s) => (
        <details key={s.id} className="store">
          <summary>{s.name}</summary>
          <StoreLayout store={s} categories={data.categories} reload={reload} />
          <div style={{ marginTop: 8 }}>
            <button className="btn small danger" onClick={() => { if (confirm(t('confirmDeleteStore', { name: s.name }))) run(() => api(`/stores/${s.id}`, { method: 'DELETE' })); }}>{t('deleteStore')}</button>
          </div>
        </details>
      ))}
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(async () => { await api(`/households/${hid}/stores`, { method: 'POST', body: { name } }); setName(''); }); }}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('storeName')} aria-label={t('storeName')} />
        <button className="btn small" type="submit">{t('addStore')}</button>
      </form>
    </>
  );
}

/* ---------------- who is an editor and who is a shopper ---------------- */

function PeopleCard({ data }: { data: Detail }) {
  const [people, setPeople] = useState<{ userId: number; name: string; role: string; locked: boolean }[]>([]);
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { const r = await api<{ private: boolean; members: typeof people }>(`/lists/${data.list.id}/members`); setPeople(r.members); setIsPrivate(r.private); }
    catch (e) { setError(errText(e)); }
  }, [data.list.id]);
  useEffect(() => { load(); }, [load]);

  const label = (r: string) => (r === 'owner' ? t('roleOwner') : r === 'contributor' ? t('roleEditor') : r === 'viewer' ? t('roleShopper') : t('roleNone'));
  return (
    <>
      <p className="muted">{t('peopleHelp')}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {people.map((p) => (
        <div className="row between" key={p.userId}>
          <span>{p.name}</span>
          {p.locked ? <span className="chip">{label(p.role)}</span> : (
            <select value={p.role} aria-label={p.name} onChange={async (e) => {
              setError('');
              try { await api(`/lists/${data.list.id}/members/${p.userId}`, { method: 'PUT', body: { role: e.target.value } }); await load(); }
              catch (err) { setError(errText(err)); }
            }}>
              <option value="contributor">{t('roleEditor')}</option>
              <option value="viewer">{t('roleShopper')}</option>
              {isPrivate && <option value="none">{t('roleNone')}</option>}
            </select>
          )}
        </div>
      ))}
    </>
  );
}

function ListSettings({ data, reload, onDeleted }: { data: Detail; reload: () => Promise<void>; onDeleted: () => void }) {
  const [name, setName] = useState(data.list.name);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <>
      <form className="inline-form" onSubmit={async (e) => {
        e.preventDefault(); setError(''); setSaved(false);
        try { await api(`/lists/${data.list.id}`, { method: 'PATCH', body: { name } }); await reload(); setSaved(true); } catch (err) { setError(errText(err)); }
      }}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label={t('listNameLabel')} required />
        <button className="btn small" type="submit">{t('saveName')}</button>
      </form>
      {saved && <p className="ok" role="status">{t('saved')}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div>
        <button className="btn danger small" onClick={async () => {
          if (!confirm(t('confirmDeleteList', { name: data.list.name }))) return;
          try { await api(`/lists/${data.list.id}`, { method: 'DELETE' }); onDeleted(); } catch (err) { setError(errText(err)); }
        }}>{t('deleteList')}</button>
      </div>
    </>
  );
}

/* ---------------- CSV: back up the item bank, restore it, or carry items to another list or household ---------------- */

type ImportRow = { line: number; name: string; action: string; matchedName: string | null; similarTo: string | null; category: string; newCategory: boolean; price: number | null; quantity: number; warnings: string[] };
type ImportPlan = { applied: boolean; summary: { create: number; update: number; skip: number; duplicateInFile: number; similar: number; addToList: number; newCategories: number }; rows: ImportRow[] };

function CsvCard({ data, reload }: { data: Detail; reload: () => Promise<void> }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [mergeSimilar, setMergeSimilar] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const call = async (apply: boolean) => {
    setBusy(true); setError(''); setDone(false);
    try {
      const r = await api<ImportPlan>(`/lists/${data.list.id}/items/import`, { method: 'POST', body: { csv, apply, overwrite, mergeSimilar } });
      setPlan(r);
      if (apply) { setDone(true); setCsv(null); setFileName(''); await reload(); }
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const pick = async (f: File | null) => {
    setPlan(null); setDone(false); setError('');
    if (!f) return;
    setFileName(f.name); setCsv(await f.text());
  };
  const label = (a: string) => ({ create: t('csvActionCreate'), update: t('csvActionUpdate'), skip: t('csvActionSkip'), duplicate_in_file: t('csvActionDup') }[a] ?? a);
  const s = plan?.summary;

  return (
    <>
      <p className="muted">{t('csvHelp')}</p>
      <div className="row">
        <a className="btn small primary" href={`/api/lists/${data.list.id}/items.csv?lang=${getLang()}`} download>{t('csvExport')}</a>
        <label className="btn small filebtn">{fileName || t('csvChoose')}
          <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { pick(e.target.files?.[0] ?? null); e.target.value = ''; }} /></label>
      </div>
      {csv !== null && (
        <div className="stack-sm">
          <label className="check"><input type="checkbox" checked={mergeSimilar} onChange={(e) => { setMergeSimilar(e.target.checked); setPlan(null); }} />{t('csvOptMerge')}</label>
          <label className="check"><input type="checkbox" checked={overwrite} onChange={(e) => { setOverwrite(e.target.checked); setPlan(null); }} />{t('csvOptOverwrite')}</label>
          <div><button className="btn" disabled={busy} onClick={() => call(false)}>{t('csvPreview')}</button></div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok" role="status">{t('csvDone')}</p>}
      {plan && !plan.applied && s && (
        <div className="stack-sm">
          <p><strong>{t('csvSummary', { create: s.create, update: s.update, addToList: s.addToList, skip: s.skip + s.duplicateInFile })}</strong></p>
          {s.similar > 0 && <p className="muted">{t('csvSimilar', { n: s.similar })}</p>}
          <div className="scroll-x">
            <table className="log">
              <tbody>
                {plan.rows.slice(0, 60).map((r) => (
                  <tr key={r.line}>
                    <td>{r.name || '—'}{r.similarTo && r.action === 'create' ? <span className="muted"> ≈ {r.similarTo}</span> : null}</td>
                    <td><span className="chip">{label(r.action)}</span></td>
                    <td>{r.quantity > 0 ? `×${fmt(r.quantity)}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div><button className="btn primary" disabled={busy} onClick={() => call(true)}>{t('csvApply')}</button></div>
        </div>
      )}
    </>
  );
}
