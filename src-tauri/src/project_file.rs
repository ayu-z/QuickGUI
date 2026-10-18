use serde_json::Value;
use std::{
    fs,
    io::{Cursor, Read, Write},
    path::Path,
};

const LIMIT: usize = 30_000_000;

pub fn suggested_filename(name: &str) -> String {
    // Display names can contain characters that are not portable file names.
    let mut stem = String::new();
    for character in name.trim().chars() {
        let character = if character.is_control() || r#"<>:"/\|?*"#.contains(character) {
            '_'
        } else {
            character
        };
        if stem.len() + character.len_utf8() > 200 {
            break;
        }
        stem.push(character);
    }
    let mut stem = stem.trim_end_matches([' ', '.']).to_owned();
    if stem.is_empty() {
        stem.push_str("project");
    }
    let basename = stem.split('.').next().unwrap_or("").to_uppercase();
    let numbered_device = ["COM", "LPT"].iter().any(|prefix| {
        basename.strip_prefix(prefix).is_some_and(|number| {
            matches!(
                number,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if matches!(basename.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered_device {
        stem.insert(0, '_');
    }
    format!("{stem}.qgui")
}

pub fn decode(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > LIMIT {
        return Err("Project exceeds the 30 MB import limit".into());
    }
    let json = if bytes.starts_with(b"PK") {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
        let entry = archive
            .by_name("quickgui.json")
            .map_err(|_| "Archive is missing quickgui.json")?;
        if entry.size() > LIMIT as u64 {
            return Err("Expanded project exceeds the 30 MB import limit".into());
        }
        let mut content = Vec::new();
        entry
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut content)
            .map_err(|e| e.to_string())?;
        if content.len() > LIMIT {
            return Err("Expanded project exceeds the 30 MB import limit".into());
        }
        content
    } else {
        bytes.to_vec()
    };
    serde_json::from_slice(&json).map_err(|e| e.to_string())
}

pub fn encode(project: &Value, archive: bool) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec_pretty(project).map_err(|e| e.to_string())?;
    if !archive {
        return Ok(json);
    }
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "quickgui.json",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(|e| e.to_string())?;
    writer.write_all(&json).map_err(|e| e.to_string())?;
    writer
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|e| e.to_string())
}

pub fn save(path: &Path, project: &Value) -> Result<(), String> {
    let archive = path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("qgui"));
    let bytes = encode(project, archive)?;
    let parent = path.parent().unwrap_or(Path::new("."));
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = parent.join(format!(".quickgui-save-{}-{nonce}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn suggested_names_preserve_unicode_without_paths_or_reserved_file_names() {
        assert_eq!(suggested_filename("  一号泵站 HMI  "), "一号泵站 HMI.qgui");
        assert_eq!(
            suggested_filename("泵站/线路\\A:*?\"<>|\0. "),
            "泵站_线路_A________.qgui"
        );
        assert_eq!(suggested_filename("..."), "project.qgui");
        assert_eq!(suggested_filename("   "), "project.qgui");
        assert_eq!(suggested_filename("con.backup"), "_con.backup.qgui");
        assert_eq!(suggested_filename("LPT1"), "_LPT1.qgui");
        assert_eq!(suggested_filename("COM¹"), "_COM¹.qgui");
        assert_eq!(suggested_filename("COM10"), "COM10.qgui");
        assert_eq!(
            suggested_filename(&"泵".repeat(200)),
            format!("{}.qgui", "泵".repeat(66))
        );
    }

    #[test]
    fn reads_json_and_the_browser_qgui_zip_format_without_extracting_paths() {
        let expected = serde_json::json!({"name":"项目 </script>","assets":[{"data":"data:image/png;base64,AA=="}]});
        for archive in [false, true] {
            assert_eq!(
                decode(&encode(&expected, archive).unwrap()).unwrap(),
                expected
            );
        }
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("../quickgui.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"{}").unwrap();
        assert!(decode(&writer.finish().unwrap().into_inner())
            .unwrap_err()
            .contains("missing quickgui.json"));
    }
}
