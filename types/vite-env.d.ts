// Vite sets import.meta.env on the page. Node, which runs the UI tests, leaves it out.
interface ImportMeta {
  readonly env?: { readonly DEV?: boolean; readonly VITE_X_BENCH_LABEL?: string };
}
