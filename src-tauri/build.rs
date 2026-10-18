use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn gather(root: &Path, path: &Path, entries: &mut Vec<(String, PathBuf)>) {
    if !path.exists() {
        return;
    }
    if path.is_dir() {
        let mut children: Vec<_> = fs::read_dir(path).unwrap().filter_map(Result::ok).collect();
        children.sort_by_key(|e| e.path());
        for entry in children {
            let name = entry.file_name();
            if [
                "target",
                "node_modules",
                "dist",
                "gen",
                ".git",
                ".toolchain",
            ]
            .iter()
            .any(|s| name == *s)
            {
                continue;
            }
            if entry.file_type().unwrap().is_symlink() {
                continue;
            }
            gather(root, &entry.path(), entries);
        }
    } else {
        entries.push((
            path.strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/"),
            path.to_path_buf(),
        ));
    }
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().unwrap();
    let mut entries = Vec::new();
    for name in [
        "src/core",
        "src/runtime",
        "src/renderer",
        "src/native",
        "crates",
        "sdk",
        "templates",
        "scripts",
        "src-tauri/src",
        "src-tauri/icons",
        "src-tauri/capabilities",
        "src-tauri/resources/c-runner/README.txt",
        "src-tauri/Cargo.toml",
        "src-tauri/build.rs",
        "src-tauri/tauri.conf.json",
        "Cargo.toml",
        "Cargo.lock",
        "LICENSE",
        "LICENSE-MIT",
        "LICENSE-APACHE",
    ] {
        let path = root.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        gather(root, &path, &mut entries);
    }
    let mut source = String::from("pub static EXPORT_SOURCES: &[(&str, &[u8])] = &[\n");
    for (name, path) in entries {
        source.push_str(&format!(
            "({name:?}, include_bytes!({:?})),\n",
            path.to_str().unwrap()
        ));
    }
    source.push_str("];\n");
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("export_sources.rs"),
        source,
    )
    .unwrap();
    tauri_build::build();
}
