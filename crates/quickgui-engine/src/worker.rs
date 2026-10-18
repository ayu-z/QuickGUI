use crate::{CancellationToken, ScriptRequest, ScriptResponse};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

const MAX_RESPONSE: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ScriptHost {
    pub executable: PathBuf,
}

impl ScriptHost {
    pub fn new(executable: PathBuf) -> Self {
        Self { executable }
    }

    pub async fn execute(
        &self,
        request: ScriptRequest,
        cancel: CancellationToken,
    ) -> Result<ScriptResponse, String> {
        self.run(request, cancel, false).await
    }

    /// Compile/link and resolve the entry point in an isolated worker, without
    /// invoking any user qg_process code. AOT validates the source hash only.
    pub async fn validate(
        &self,
        request: ScriptRequest,
        cancel: CancellationToken,
    ) -> Result<(), String> {
        self.run(request, cancel, true).await.map(|_| ())
    }

    async fn run(
        &self,
        request: ScriptRequest,
        cancel: CancellationToken,
        check_only: bool,
    ) -> Result<ScriptResponse, String> {
        if request.source.len() > 1024 * 1024 {
            return Err("C source exceeds 1 MiB limit".into());
        }
        if request
            .variables
            .values()
            .chain(request.state.values())
            .any(|x| !x.is_finite())
        {
            return Err("C worker input contains a non-finite number".into());
        }
        if cancel.is_cancelled() {
            return Err("C execution cancelled".into());
        }
        let mut bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_RESPONSE {
            return Err("C worker request exceeds 2 MiB".into());
        }
        let manifest = self
            .executable
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("aot-manifest.json");
        let executable = if manifest.is_file() {
            let modules: std::collections::BTreeMap<String, String> =
                serde_json::from_slice(&std::fs::read(&manifest).map_err(|e| e.to_string())?)
                    .map_err(|e| format!("Invalid AOT manifest: {e}"))?;
            let hash = format!("{:x}", Sha256::digest(request.source.as_bytes()));
            let file = modules
                .get(&hash)
                .ok_or("No AOT worker matches this C source; rebuild the standalone application")?;
            let path = std::path::Path::new(file);
            if path.components().count() != 1 || path.file_name().is_none() {
                return Err("AOT manifest paths must be plain filenames".into());
            }
            manifest.parent().unwrap().join(file)
        } else {
            self.executable.clone()
        };
        let timeout = Duration::from_millis(request.timeout_ms.clamp(1, 60_000));
        let deadline = tokio::time::Instant::now() + timeout;
        if check_only {
            // Probe with empty stdin: an older runner cannot receive or execute
            // user source before proving compile-only support.
            let capabilities = run_worker(
                &executable,
                &["--capabilities"],
                &[],
                cancel.clone(),
                deadline,
                timeout,
                16 * 1024,
            )
            .await?;
            let capabilities: serde_json::Value =
                serde_json::from_slice(&capabilities).map_err(|_| {
                    "C worker does not advertise compile-only validation; rebuild native artifacts"
                        .to_owned()
                })?;
            if capabilities
                .get("compileCheck")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            {
                return Err("C worker does not support compile-only validation; rebuild native artifacts before validating scripts".into());
            }
        }
        let args: &[&str] = if check_only { &["--check"] } else { &[] };
        let output = run_worker(
            &executable,
            args,
            &bytes,
            cancel,
            deadline,
            timeout,
            MAX_RESPONSE,
        )
        .await?;
        let value: serde_json::Value = serde_json::from_slice(&output)
            .map_err(|e| format!("Invalid C worker response: {e}"))?;
        if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
            return Err(error.to_owned());
        }
        let response: ScriptResponse = serde_json::from_value(value)
            .map_err(|e| format!("Invalid C response contract: {e}"))?;
        if response
            .writes
            .values()
            .chain(response.state.values())
            .any(|x| !x.is_finite())
        {
            return Err("C worker returned a non-finite number".into());
        }
        Ok(response)
    }
}

async fn run_worker(
    executable: &std::path::Path,
    args: &[&str],
    bytes: &[u8],
    cancel: CancellationToken,
    deadline: tokio::time::Instant,
    timeout: Duration,
    max_output: u64,
) -> Result<Vec<u8>, String> {
    if cancel.is_cancelled() {
        return Err("C execution cancelled".into());
    }
    if tokio::time::Instant::now() >= deadline {
        return Err(format!(
            "C worker timed out after {} ms",
            timeout.as_millis()
        ));
    }
    let mut command = Command::new(executable);
    command.args(args);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Cannot start C worker {}: {e}", executable.display()))?;
    let mut stdin = child.stdin.take().ok_or("C worker stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("C worker stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("C worker stderr unavailable")?;
    // Drains are bounded: a script cannot fill a pipe and deadlock the host.
    let stdout_task = tokio::spawn(async move {
        let mut out = Vec::new();
        stdout
            .take(max_output + 1)
            .read_to_end(&mut out)
            .await
            .map(|_| out)
    });
    let stderr_task = tokio::spawn(async move {
        let mut out = Vec::new();
        stderr
            .take(64 * 1024)
            .read_to_end(&mut out)
            .await
            .map(|_| out)
    });
    let operation = async {
        stdin
            .write_all(bytes)
            .await
            .map_err(|e| format!("C worker request failed: {e}"))?;
        drop(stdin);
        child.wait().await.map_err(|e| e.to_string())
    };
    let status = tokio::select! {
        _ = cancel.cancelled() => Err("C execution cancelled".to_owned()),
        result = tokio::time::timeout_at(deadline, operation) => result.map_err(|_| format!("C worker timed out after {} ms", timeout.as_millis())).and_then(|r| r),
    };
    if status.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let stdout_abort = stdout_task.abort_handle();
    let stderr_abort = stderr_task.abort_handle();
    let drains = tokio::time::timeout(Duration::from_secs(1), async {
        let output = stdout_task
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let errors = stderr_task
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        Ok::<_, String>((output, errors))
    })
    .await;
    let (output, errors) = match drains {
        Ok(result) => result?,
        Err(_) => {
            stdout_abort.abort();
            stderr_abort.abort();
            return Err(status
                .err()
                .unwrap_or_else(|| "C worker output pipe failed to close".into()));
        }
    };
    let status = status?;
    if !status.success() {
        return Err(format!(
            "C worker exited abnormally ({status}): {}",
            String::from_utf8_lossy(&errors)
        ));
    }
    if output.len() as u64 > max_output {
        return Err("C worker response exceeds size limit".into());
    }
    Ok(output)
}
