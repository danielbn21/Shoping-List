import type { ReactNode } from 'react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { t } from './i18n';

// Pointer (mouse, touch, pen) + keyboard (space to pick up, arrows to move). The handle has touch-action: none
// so dragging it does not scroll the page; the rest of the row still scrolls normally.
export function useDndSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

export function SortableRow({ id, className, children }: { id: UniqueIdentifier; className?: string; children: (handle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const handle = (
    <button type="button" className="handle" aria-label={t('dragHandle')} title={t('dragHandle')} {...attributes} {...listeners}>⠿</button>
  );
  return (
    <div ref={setNodeRef} className={className}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.65 : 1, position: 'relative', zIndex: isDragging ? 2 : undefined }}>
      {children(handle)}
    </div>
  );
}

// A simple vertical sortable list. onReorder receives the new order.
export function SortableList<T extends { id: number }>({ items, onReorder, render }: {
  items: T[]; onReorder: (next: T[]) => void; render: (item: T, handle: ReactNode) => ReactNode;
}) {
  const sensors = useDndSensors();
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.id === active.id);
    const to = items.findIndex((i) => i.id === over.id);
    if (from >= 0 && to >= 0) onReorder(arrayMove(items, from, to));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((i) => (
          <SortableRow key={i.id} id={i.id} className="sort-row">{(h) => render(i, h)}</SortableRow>
        ))}
      </SortableContext>
    </DndContext>
  );
}
