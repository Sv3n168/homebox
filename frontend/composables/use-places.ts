// Boxes this device uses a lot: pinned ones and the most recently visited.
// Stored per device (localStorage) — no change to the Homebox data.

const RECENT_MAX = 8;

export function usePlaces() {
  const recent = useLocalStorage<string[]>("homebox/places/recent", []);
  const pinned = useLocalStorage<string[]>("homebox/places/pinned", []);

  function visit(id: string) {
    recent.value = [id, ...recent.value.filter(x => x !== id)].slice(0, RECENT_MAX);
  }

  function isPinned(id: string) {
    return pinned.value.includes(id);
  }

  function togglePin(id: string) {
    pinned.value = isPinned(id) ? pinned.value.filter(x => x !== id) : [...pinned.value, id];
  }

  /** Pinned first, then recent, no duplicates. */
  const favorites = computed(() => [...pinned.value, ...recent.value.filter(id => !pinned.value.includes(id))]);

  return { recent, pinned, favorites, visit, isPinned, togglePin };
}
