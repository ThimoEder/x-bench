// The window shows at most two sessions, from any provider.

export interface Desk {
  ids(): string[];
  has(id: string): boolean;
  // The host also asks with no id, which checks only for a free pane.
  canAdd(id?: string): boolean;
  replace(id: string): string[];
  add(id: string): DeskChange;
  replaceSlot(currentId: string, nextId: string): DeskChange;
  remove(id: string): string[];
  clear(): string[];
  // Each load, new session and surface switch claims the desk. The answer tells whether a newer claim came since.
  claim(): () => boolean;
}

export interface DeskChange {
  ok: boolean;
  already: boolean;
}

export function createDesk(): Desk {
  const ids: string[] = [];
  let claims = 0;
  return {
    ids() {
      return [...ids];
    },
    has(id) {
      return ids.includes(id);
    },
    canAdd(id) {
      return (id !== undefined && ids.includes(id)) || ids.length < 2;
    },
    replace(id) {
      ids.splice(0, ids.length, id);
      return this.ids();
    },
    add(id) {
      if (ids.includes(id)) return { ok: true, already: true };
      if (ids.length >= 2) return { ok: false, already: false };
      ids.push(id);
      return { ok: true, already: false };
    },
    replaceSlot(currentId, nextId) {
      if (currentId !== nextId && ids.includes(nextId)) return { ok: true, already: true };
      const index = ids.indexOf(currentId);
      if (index < 0) {
        ids.push(nextId);
        return { ok: true, already: false };
      }
      ids[index] = nextId;
      return { ok: true, already: false };
    },
    remove(id) {
      const index = ids.indexOf(id);
      if (index >= 0) ids.splice(index, 1);
      return this.ids();
    },
    clear() {
      ids.splice(0, ids.length);
      return this.ids();
    },
    claim() {
      const mine = ++claims;
      return () => mine === claims;
    },
  };
}
