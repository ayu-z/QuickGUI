# Standalone HMI source

This directory contains the complete project JSON, React renderer, Rust engine/native window host, C worker/SDK, and build scripts. It builds without QuickGUI installed.

Prerequisites: Node.js 22+, Rust stable, a platform C/C++ toolchain, and the Tauri platform prerequisites. On macOS install Xcode Command Line Tools. On Windows install Visual Studio C++ Build Tools and WebView2. Build each package on its target operating system; cross-platform installers are not produced by renaming an output.

```sh
npm ci
npm run build
cargo test -p quickgui-engine
npm run desktop:build
```

Runtime packages compile each project script ahead of time with CMake and Cargo. The source hash selects the matching worker at runtime, so the end user's application does not need a C compiler. Changing scripts requires rebuilding the package. See the SDK documentation for the C/C++ interface and its C ABI. The design-time JIT mode can instead be built with `node scripts/setup-tcc.mjs` followed by `node scripts/build-native.mjs --jit`; it requires a working TinyCC library. An external toolchain can be supplied with `QG_LIBTCC` and `QG_TCC_HOME`.

`npm run dev` runs the renderer in a browser; C execution requires `npm run desktop`. `npm run desktop:build` stages and tests native dependencies, regenerates icons, and invokes the standard Tauri build. `--target <rust-triple>` selects an installed Rust target. The host OS must match the target OS. CMake users may configure with `cmake -S . -B build` and build `web`, `engine`, or `desktop` targets.

`project.json` is the unmodified source document, imported as JSON rather than interpolated into executable code. `project-scripts/*.c` files mirror project scripts for inspection; runtime uses the embedded JSON sources. Editing JSON does not execute a script during export. The installer uses `publish.appName`, `identifier`, `version`, `publisher`, and icon settings. macOS app icons use ICNS; Windows application/shortcut icons use ICO. Windows corner preferences require Windows 11; macOS retains native window decoration.

Release builds are unsigned unless platform signing credentials are supplied to the normal Tauri toolchain. Distribution signing/notarization is a release step, not a property of a source export.

Custom React component source packages are extracted to `components/<localId>/` and remain embedded in `project.json`. After editing a component, run `node scripts/build-component.mjs components/<localId> artifacts/<localId>.qgcomponent --project project.json --module <localId>` to rebuild the package and atomically replace that module's embedded implementation. The local module ID, original source identity and scoped resources are preserved. Omitting both flags only writes the package; it does not update the running project. The runtime preserves the component trust decision; a ShadowRoot isolates styles, not JavaScript authority.

Schema v3 retains JSON variable paths, versioned widget properties, multiple windows and scoped resources. Browser previews and native applications use the exported renderer and flow semantics. Historical chart queries require the native SQLite host. C aliases resolve the original script's names to local numeric variable IDs without changing source code or ABI 2.
