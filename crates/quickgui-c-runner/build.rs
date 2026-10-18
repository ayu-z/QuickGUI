fn main() {
    println!("cargo:rerun-if-env-changed=QG_AOT_LIBRARY_DIR");
    println!("cargo:rerun-if-env-changed=QG_AOT_SOURCE");
    if std::env::var_os("CARGO_FEATURE_AOT").is_some() {
        let directory = std::env::var("QG_AOT_LIBRARY_DIR")
            .expect("aot requires QG_AOT_LIBRARY_DIR from sdk/aot CMake build");
        println!("cargo:rustc-link-search=native={directory}");
        println!("cargo:rustc-link-lib=static=quickgui_script");
        use sha2::{Digest, Sha256};
        let source = std::env::var("QG_AOT_SOURCE").expect("aot requires QG_AOT_SOURCE");
        println!("cargo:rerun-if-changed={source}");
        let bytes = std::fs::read(&source).expect("Cannot read AOT C source");
        println!("cargo:rustc-env=QG_AOT_HASH={:x}", Sha256::digest(&bytes));
        std::fs::write(
            std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("aot_script.c"),
            bytes,
        )
        .unwrap();
    }
}
