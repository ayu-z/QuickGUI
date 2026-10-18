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
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

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

async fn pipe_output<R: AsyncRead + Unpin>(read: R, window: WebviewWindow, stage: String) {
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(message)) = lines.next_line().await {
        let _ = window.emit(
            "build-progress",
            BuildProgress {
                stage: stage.clone(),
                message,
            },
        );
    }
}

async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    let _ = tokio::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
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
    if token.is_cancelled() {
        return Err("Build cancelled".into());
    }
    let _ = window.emit(
        "build-progress",
        BuildProgress {
            stage: stage.into(),
            message: format!("{executable} {}", args.join(" ")),
        },
    );
    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("Cannot start {executable}: {e}. Install the required build tool and restart QuickGUI so PATH is refreshed."))?;
    let pid = child.id();
    let stdout = tokio::spawn(pipe_output(
        child.stdout.take().unwrap(),
        window.clone(),
        stage.into(),
    ));
    let stderr = tokio::spawn(pipe_output(
        child.stderr.take().unwrap(),
        window.clone(),
        stage.into(),
    ));
    let result = tokio::select! {
        _ = token.cancelled() => {
            if let Some(pid) = pid { kill_tree(pid).await; }
            let _ = child.kill().await;
            Err("Build cancelled".to_string())
        },
        status = child.wait() => status.map_err(|e| e.to_string()).and_then(|s| if s.success() { Ok(()) } else { Err(format!("{stage} failed ({s}); see build output")) }),
    };
    if result.is_err() {
        stdout.abort();
        stderr.abort();
    } else {
        let _ = tokio::join!(stdout, stderr);
    }
    result
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
