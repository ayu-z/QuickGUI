use serde_json::{json, Value};
use std::{fs, path::Path};

include!(concat!(env!("OUT_DIR"), "/export_sources.rs"));

pub fn export(project: &Value, output: &Path) -> Result<(), String> {
    if !matches!(
        project.get("schemaVersion").and_then(Value::as_u64),
        Some(1 | 2 | 3 | 4)
    ) {
        return Err("Unsupported project schema".into());
    }
    if output.exists()
        && fs::read_dir(output)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err("Source export requires an empty output directory".into());
    }
    fs::create_dir_all(output).map_err(|e| e.to_string())?;
    for (relative, contents) in EXPORT_SOURCES {
        let path = output.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(path, contents).map_err(|e| e.to_string())?;
    }
    for (relative, contents) in EXPORT_SOURCES {
        if let Some(relative) = relative.strip_prefix("templates/runtime/") {
            let path = output.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(path, contents).map_err(|e| e.to_string())?;
        }
    }
    fs::write(
        output.join("project.json"),
        serde_json::to_vec_pretty(project).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let publish = project.get("publish").ok_or("Missing publish settings")?;
    let config_path = output.join("src-tauri/tauri.conf.json");
    let mut config: Value =
        serde_json::from_slice(&fs::read(&config_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    for (key, source) in [
        ("productName", "appName"),
        ("identifier", "identifier"),
        ("version", "version"),
    ] {
        if let Some(value) = publish
            .get(source)
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        {
            config[key] = value.clone();
        }
    }
    if let Some(publisher) = publish
        .get("publisher")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    {
        config["bundle"]["publisher"] = publisher.clone();
    }
    let window = project.get("window").ok_or("Missing window settings")?;
    let mut native =
        json!({"label":"preview","url":"index.html?runtime=1&windowId=main","decorations":true});
    for key in [
        "title",
        "width",
        "height",
        "minWidth",
        "minHeight",
        "resizable",
        "alwaysOnTop",
        "fullscreen",
        "maximized",
        "center",
    ] {
        if let Some(value) = window.get(key) {
            native[key] = value.clone();
        }
    }
    config["app"]["windows"] = json!([native]);
    fs::write(
        config_path,
        serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if let Some(scripts) = project.get("scripts").and_then(Value::as_array) {
        let directory = output.join("project-scripts");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        for (i, script) in scripts.iter().enumerate() {
            fs::write(
                directory.join(format!("script-{i}.c")),
                script.get("source").and_then(Value::as_str).unwrap_or(""),
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if let Some(modules) = project.get("modules").and_then(Value::as_array) {
        for (index, module) in modules.iter().enumerate() {
            let Some(files) = module
                .get("implementation")
                .and_then(|i| i.get("files"))
                .and_then(Value::as_object)
            else {
                continue;
            };
            let id = module
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| {
                    id.len() <= 100
                        && id
                            .as_bytes()
                            .first()
                            .is_some_and(|b| b.is_ascii_alphabetic())
                        && id
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
                })
                .map(str::to_owned)
                .unwrap_or_else(|| format!("module-{index}"));
            for (relative, text) in files {
                if relative.is_empty()
                    || relative.chars().any(char::is_control)
                    || relative.contains('\\')
                    || relative.contains(':')
                    || relative
                        .split('/')
                        .any(|part| part.is_empty() || part == "." || part == "..")
                {
                    return Err(format!("Unsafe component source path: {relative}"));
                }
                let text = text.as_str().ok_or("Component source must be UTF-8 text")?;
                let path = output.join("components").join(&id).join(relative);
                fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::write(path, text).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exports_v4_project_with_native_serial_and_flow_sources() {
        let project = json!({"schemaVersion":4,"windows":[],"window":{"title":"Serial","width":960,"height":640},"publish":{"appName":"Serial","identifier":"dev.example.serial","version":"1.0.0"},"flows":[{"id":"flow","nodes":[{"id":"scan","kind":"serial","config":{"action":"scan"}}]}]});
        let directory = std::env::temp_dir().join(format!(
            "quickgui-serial-export-{}-{}",
            std::process::id(),
            quickgui_engine::now_ms()
        ));
        export(&project, &directory).unwrap();
        let exported: Value =
            serde_json::from_slice(&fs::read(directory.join("project.json")).unwrap()).unwrap();
        assert_eq!(exported, project);
        for path in [
            "crates/quickgui-engine/src/serial.rs",
            "crates/quickgui-engine/src/flow_v4.rs",
            "src/native/bridge.ts",
            "src/runtime/engine.ts",
            "src/core/examples.ts",
            "src/examples/serialAssistant.ts",
        ] {
            assert!(directory.join(path).is_file(), "export is missing {path}");
        }
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn exports_v3_json_paths_and_scopes_without_downgrading() {
        let project = json!({
            "schemaVersion":3, "window":{"title":"V3","width":960,"height":640},
            "windows":[{"id":"detail","widgets":[]}],
            "publish":{"appName":"V3","identifier":"dev.example.v3","version":"1.0.0"},
            "variables":[{"id":"data","type":"json","initial":{"samples":[1,null]}}],
            "widgets":[{"id":"value","definitionVersion":2,"bindings":{"value":{"variable":"data","path":["samples",0],"mode":"twoWay"}}}],
            "resourceScopes":[{"id":"source","locale":"en"}],
            "scripts":[{"id":"aliased","variableAliases":{"original":"local"},"source":"void qg_process(void) {}"}]
        });
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("quickgui-v3-{}-{nonce}", std::process::id()));
        export(&project, &directory).unwrap();
        let actual: Value =
            serde_json::from_slice(&fs::read(directory.join("project.json")).unwrap()).unwrap();
        assert_eq!(actual, project);
        assert!(directory.join("src/core/propertySchema.ts").is_file());
        fs::remove_dir_all(&directory).unwrap();
        let mut future = project;
        future["schemaVersion"] = json!(5);
        assert!(export(&future, &directory)
            .unwrap_err()
            .contains("Unsupported"));
        assert!(!directory.exists());
    }
    #[test]
    fn exports_full_json_and_standalone_native_entry_without_overwriting_existing_work() {
        let project = json!({"schemaVersion":1,"name":"</script><script>unexpected()</script>","window":{"title":"Quoted \" title","width":960,"height":640},"publish":{"appName":"Pump Station","identifier":"dev.example.pump","version":"1.2.3","publisher":""},"scripts":[{"id":"../../outside","source":"void qg_process(void) {}"}],"assets":[{"id":"asset","data":"data:text/plain;base64,dGVzdA=="}]});
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("quickgui-source-{}-{nonce}", std::process::id()));
        export(&project, &directory).unwrap();
        let actual: Value =
            serde_json::from_slice(&fs::read(directory.join("project.json")).unwrap()).unwrap();
        assert_eq!(actual, project);
        let entry = fs::read_to_string(directory.join("src/main.tsx")).unwrap();
        assert!(entry.contains("createRuntime(project,"));
        assert!(entry.contains("attachOnly"));
        assert!(!entry.contains("unexpected()"));
        let config: Value =
            serde_json::from_slice(&fs::read(directory.join("src-tauri/tauri.conf.json")).unwrap())
                .unwrap();
        assert_eq!(config["app"]["windows"][0]["label"], "preview");
        assert_eq!(config["productName"], "Pump Station");
        assert!(directory.join("project-scripts/script-0.c").is_file());
        assert!(directory.join("sdk/quickgui.h").is_file());
        assert!(directory
            .join("crates/quickgui-engine/src/lib.rs")
            .is_file());
        assert!(export(&project, &directory).unwrap_err().contains("empty"));
        fs::remove_dir_all(directory).unwrap();
    }
}
