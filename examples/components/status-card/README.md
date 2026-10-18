# QuickGUI React component example

Build from the QuickGUI workspace root:

```sh
node scripts/build-component.mjs examples/components/status-card artifacts/status-card.qgcomponent
```

Import the resulting package from the designer's Modules panel after reviewing and trusting its source. A component package contains executable JavaScript with the privileges of the app page. Shadow DOM isolates its CSS; it is **not a security sandbox**.

`manifest.json` declares identity, dimensions, the TS/TSX entry, an optional CSS entry, JSON property defaults and event names. The entry's default export receives `{ props, emit, context }`. CSS imports and the manifest stylesheet are bundled into the component's shadow root. The package includes its own React and ReactDOM, with no CDN or runtime dependency downloads.

`context` provides `locale`, `theme`, `translations`, `t(key)`, `interactive`, `width` and `height`. Update props through ordinary data bindings; call a declared event such as `emit('advance', nextValue)` to invoke an assigned flow. The designer sets `interactive` to false. React state survives property, locale and theme updates, and React effect cleanup runs when the component unmounts.

The example exposes `label`, `value` and `unit`, and emits `advance`. Add an instance, bind `value` to a variable, and connect `onAdvance` to a flow. Its local click counter demonstrates that host property updates preserve component state.

The original UTF-8 source files are embedded in `implementation.files` and exported under `components/<component-id>/` in a standalone source project. Edit the sources and rerun the same build command to produce an updated package. Source inputs are limited to 128 UTF-8 files (1 MB each, 6 MB total); use inline data URLs for binary assets. Bundles are limited to 8 MB. Symlinks, imports escaping the component/package dependency directories and remote module imports are rejected by the builder.
