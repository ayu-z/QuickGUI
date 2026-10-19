use crate::{source_export, HostState};
use quickgui_engine::CancellationToken;
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};
use tauri::{Emitter, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildProgress {
    stage: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    source_dir: String,
    artifact_dir: String,
    artifacts: Vec<String>,
    signing_status: String,
}

async fn pipe_output<R: AsyncRead + Unpin>(
    mut read: R,
    emit: impl Fn(BuildProgress),
    stage: String,
) -> std::io::Result<()> {
    let mut buffer = [0; 4096];
    let mut line = Vec::new();
    loop {
        let count = read.read(&mut buffer).await?;
        for &byte in &buffer[..count] {
            if byte == b'\r' || byte == b'\n' {
                if line.is_empty() {
                    continue;
                }
            } else {
                line.push(byte);
                if line.len() < 16_384 {
                    continue;
                }
            }
            emit(BuildProgress {
                stage: stage.clone(),
                message: String::from_utf8_lossy(&line).into_owned(),
            });
            line.clear();
        }
        if count == 0 {
            if !line.is_empty() {
                emit(BuildProgress {
                    stage,
                    message: String::from_utf8_lossy(&line).into_owned(),
                });
            }
            return Ok(());
        }
    }
}

async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    let _ = tokio::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .await;
    #[cfg(unix)]
    let _ = tokio::process::Command::new("kill")
        .args(["-TERM", "--", &format!("-{pid}")])
        .output()
        .await;
}

async fn step(
    window: &WebviewWindow,
    token: &CancellationToken,
    directory: &Path,
    stage: &str,
    executable: &str,
    args: &[&str],
) -> Result<(), String> {
    let window = window.clone();
    run_step(token, directory, stage, executable, args, move |progress| {
        let _ = window.emit("build-progress", progress);
    })
    .await
}

async fn run_step(
    token: &CancellationToken,
    directory: &Path,
    stage: &str,
    executable: &str,
    args: &[&str],
    emit: impl Fn(BuildProgress) + Clone + Send + 'static,
) -> Result<(), String> {
    if token.is_cancelled() {
        return Err("Build cancelled".into());
    }
    emit(BuildProgress {
        stage: stage.into(),
        message: format!("{executable} {}", args.join(" ")),
    });
    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW; output stays in the designer.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("Cannot start {executable}: {e}. Install the required build tool and restart QuickGUI so PATH is refreshed."))?;
    let pid = child.id();
    let mut stdout = tokio::spawn(pipe_output(
        child.stdout.take().unwrap(),
        emit.clone(),
        stage.into(),
    ));
    let mut stderr = tokio::spawn(pipe_output(
        child.stderr.take().unwrap(),
        emit,
        stage.into(),
    ));
    let completion = async {
        let status = child.wait().await.map_err(|e| e.to_string())?;
        // A failed compiler can exit before its final diagnostic has been read.
        // Drain both streams on failure as well as success before reporting exit.
        let (stdout, stderr) = tokio::join!(&mut stdout, &mut stderr);
        for output in [stdout, stderr] {
            output
                .map_err(|e| format!("Cannot read {stage} build output: {e}"))?
                .map_err(|e| format!("Cannot read {stage} build output: {e}"))?;
        }
        if status.success() {
            Ok(())
        } else {
            Err(format!("{stage} failed ({status}); see build output"))
        }
    };
    tokio::select! {
        result = completion => result,
        _ = token.cancelled() => {
            if let Some(pid) = pid { kill_tree(pid).await; }
            let _ = child.kill().await;
            stdout.abort();
            stderr.abort();
            Err("Build cancelled".to_string())
        },
    }
}

fn collect_artifacts(dir: &Path, result: &mut Vec<String>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| {
                ["dmg", "app", "exe", "msi"]
                    .iter()
                    .any(|candidate| ext == *candidate)
            }) {
                result.push(path.to_string_lossy().into_owned());
            } else if path.is_dir() {
                collect_artifacts(&path, result);
            }
        }
    }
}

#[tauri::command]
pub async fn build_runtime(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, HostState>,
    project: Value,
    output_dir: Option<String>,
    generation: Option<u64>,
) -> Result<Option<BuildResult>, String> {
    window
        .is_visible()
        .map_err(|_| "The runtime window has already closed")?;
    let work = crate::begin_work(&state, window.label(), generation)?;
    let token = work.cancellation.clone();
    {
        let mut jobs = state.builds.lock().map_err(|e| e.to_string())?;
        if jobs.contains_key(window.label()) {
            return Err("A build is already running for this window".into());
        }
        jobs.insert(window.label().into(), token.clone());
    }
    let result: Result<Option<BuildResult>, String> = async {
        let directory = match output_dir {
            Some(value) => PathBuf::from(value),
            None => match app.dialog().file().blocking_pick_folder() {
                Some(value) => value.into_path().map_err(|e| e.to_string())?.join("quickgui-runtime"),
                None => return Ok(None),
            },
        };
        let source = directory.join("source");
        if token.is_cancelled() { return Err("Build cancelled".into()); }
        let _ = window.emit("build-progress", BuildProgress { stage: "source".into(), message: format!("Exporting source to {}", source.display()) });
        source_export::export(&project, &source)?;
        let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
        step(&window, &token, &source, "toolchain", "node", &["--version"]).await?;
        step(&window, &token, &source, "toolchain", "cargo", &["--version"]).await?;
        let install = if source.join("package-lock.json").is_file() { "ci" } else { "install" };
        step(&window, &token, &source, "dependencies", npm, &[install]).await?;
        step(&window, &token, &source, "package", "node", &["scripts/build-native.mjs", "--aot"]).await?;
        let artifacts_dir = source.join("target/release/bundle");
        let mut artifacts = Vec::new();
        collect_artifacts(&artifacts_dir, &mut artifacts);
        if artifacts.is_empty() { return Err("Build exited successfully but no native installer/app was found in target/release/bundle".into()); }
        let _ = window.emit("build-progress", BuildProgress { stage: "complete".into(), message: artifacts.join("\n") });
        Ok(Some(BuildResult { source_dir: source.to_string_lossy().into_owned(), artifact_dir: artifacts_dir.to_string_lossy().into_owned(), artifacts, signing_status: "not-verified; distribution signing requires external credentials".into() }))
    }.await;
    if let Ok(mut jobs) = state.builds.lock() {
        jobs.remove(window.label());
    }
    if let Err(error) = &result {
        let _ = window.emit(
            "build-progress",
            BuildProgress {
                stage: "error".into(),
                message: error.clone(),
            },
        );
    }
    result
}

#[tauri::command]
pub fn cancel_build(window: WebviewWindow, state: State<'_, HostState>) -> Result<(), String> {
    if let Some(token) = state
        .builds
        .lock()
        .map_err(|e| e.to_string())?
        .get(window.label())
    {
        token.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn output_streams_before_exit_and_survives_windows_bytes_and_line_endings() {
        let (mut writer, reader) = tokio::io::duplex(256);
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(pipe_output(
            reader,
            move |line| {
                send.send(line).unwrap();
            },
            "package".into(),
        ));
        writer.write_all(b"first\r").await.unwrap();
        let first = tokio::time::timeout(std::time::Duration::from_secs(2), receive.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.stage, "package");
        assert_eq!(first.message, "first");
        writer
            .write_all(b"\nlocalized: \x81\xff\r\nnext\nlast diagnostic")
            .await
            .unwrap();
        drop(writer);
        task.await.unwrap().unwrap();
        let mut messages = Vec::new();
        while let Some(line) = receive.recv().await {
            messages.push(line.message);
        }
        assert_eq!(
            messages,
            ["localized: \u{fffd}\u{fffd}", "next", "last diagnostic"]
        );
    }

    #[tokio::test]
    async fn utf8_characters_split_across_reads_are_preserved_and_long_lines_are_bounded() {
        let (mut writer, reader) = tokio::io::duplex(16);
        let messages = Arc::new(Mutex::new(Vec::new()));
        let captured = messages.clone();
        let task = tokio::spawn(pipe_output(
            reader,
            move |line| {
                captured.lock().unwrap().push(line.message);
            },
            "package".into(),
        ));
        writer.write_all(&[0xe4]).await.unwrap();
        tokio::task::yield_now().await;
        writer.write_all(&[0xb8, 0xad, b'\n']).await.unwrap();
        writer.write_all(&vec![b'x'; 20_000]).await.unwrap();
        drop(writer);
        task.await.unwrap().unwrap();
        let messages = messages.lock().unwrap();
        assert_eq!(messages[0], "中");
        assert_eq!(messages[1].len(), 16_384);
        assert_eq!(messages[2].len(), 3_616);
    }

    #[tokio::test]
    async fn failed_build_keeps_final_stdout_and_stderr() {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let captured = messages.clone();
        #[cfg(windows)]
        let (executable, args) = (
            "cmd.exe",
            vec![
                "/D",
                "/C",
                "echo stdout-final & echo stderr-final 1>&2 & exit /b 7",
            ],
        );
        #[cfg(not(windows))]
        let (executable, args) = (
            "sh",
            vec!["-c", "printf stdout-final; printf stderr-final >&2; exit 7"],
        );
        let result = run_step(
            &CancellationToken::new(),
            Path::new("."),
            "package",
            executable,
            &args,
            move |line| {
                captured.lock().unwrap().push(line.message);
            },
        )
        .await;
        assert!(result.unwrap_err().contains("package failed"));
        let messages = messages.lock().unwrap();
        assert!(messages.iter().any(|line| line.trim() == "stdout-final"));
        assert!(messages.iter().any(|line| line.trim() == "stderr-final"));
    }

    #[tokio::test]
    async fn cancelling_a_running_build_stops_its_process_tree() {
        let token = CancellationToken::new();
        let cancel = token.clone();
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        #[cfg(windows)]
        let (executable, args) = (
            "cmd.exe",
            vec!["/D", "/C", "echo ready & ping -n 30 127.0.0.1 >nul"],
        );
        #[cfg(not(windows))]
        let (executable, args) = ("sh", vec!["-c", "printf 'ready\\n'; sleep 30"]);
        let task = tokio::spawn(async move {
            run_step(
                &token,
                Path::new("."),
                "package",
                executable,
                &args,
                move |line| {
                    let _ = send.send(line.message);
                },
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let line = receive.recv().await.expect("build exited before readiness");
                if line.trim() == "ready" {
                    break;
                }
            }
        })
        .await
        .unwrap();
        cancel.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err(), "Build cancelled");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_batch_build_tools_capture_output_from_paths_with_spaces() {
        let directory = std::env::temp_dir().join(format!(
            "quickgui build output {}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let batch = directory.join("build tool.cmd");
        fs::write(
            &batch,
            "@echo off\r\necho dependency-output\r\necho dependency-error 1>&2\r\n",
        )
        .unwrap();
        let messages = Arc::new(Mutex::new(Vec::new()));
        let captured = messages.clone();
        let result = run_step(
            &CancellationToken::new(),
            &directory,
            "dependencies",
            batch.to_str().unwrap(),
            &[],
            move |line| {
                captured.lock().unwrap().push(line.message);
            },
        )
        .await;
        fs::remove_dir_all(&directory).unwrap();
        result.unwrap();
        let messages = messages.lock().unwrap();
        assert!(messages.iter().any(|line| line == "dependency-output"));
        assert!(messages
            .iter()
            .any(|line| line.trim() == "dependency-error"));
    }
}
