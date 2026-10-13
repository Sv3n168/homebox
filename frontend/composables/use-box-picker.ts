// Promise-based "choose a box": search, pinned/recent boxes or scan its label.
// The dialog itself (components/Location/PickerDialog.vue) lives in the layout.

export type PickedBox = { id: string; name: string; treeString: string };

type PickOptions = { title?: string; exclude?: string[]; scan?: boolean };

const state = reactive({
  open: false,
  title: "",
  exclude: [] as string[],
  scanning: false,
  resolve: null as null | ((box: PickedBox | null) => void),
});

export function useBoxPicker() {
  function pick(opts: PickOptions = {}): Promise<PickedBox | null> {
    state.resolve?.(null);
    return new Promise(resolve => {
      state.title = opts.title ?? "";
      state.exclude = opts.exclude ?? [];
      state.scanning = !!opts.scan;
      state.resolve = resolve;
      state.open = true;
    });
  }

  function finish(box: PickedBox | null) {
    const resolve = state.resolve;
    state.resolve = null;
    state.open = false;
    state.scanning = false;
    resolve?.(box);
  }

  return { state, pick, finish };
}
