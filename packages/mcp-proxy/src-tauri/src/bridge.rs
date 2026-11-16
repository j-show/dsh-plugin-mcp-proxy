//! Private, bounded supervisor channel. No shell or network capability is exposed to the WebView.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
pub struct Bridge {
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    sequence: AtomicU64,
    closing: AtomicBool,
    pub state: Mutex<Option<Value>>,
    _child: Mutex<Child>,
    owner: Arc<super::supervisor_owner::SupervisorOwner>,
    resources: PathBuf,
    service: Mutex<Option<Value>>,
}
impl Bridge {
    pub fn start(resources: &Path, app: AppHandle) -> Result<Arc<Self>, String> {
        let node =
            resources
                .join("dsh/runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        let mut command = Command::new(node);
        if cfg!(debug_assertions) && std::env::var_os("MCP_PROXY_INSPECT").is_some() {
            command.arg("--inspect=127.0.0.1:9231");
        }
        command
            .arg(resources.join("desktop-host.mjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(
                super::diagnostics::log()
                    .map(Stdio::from)
                    .unwrap_or_else(Stdio::null),
            );
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        super::supervisor_owner::SupervisorOwner::prepare(&mut command);
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot start bundled Node supervisor")?;
        let owner = match super::supervisor_owner::SupervisorOwner::attach(&child) {
            Ok(owner) => Arc::new(owner),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let input = child.stdin.take().ok_or("Supervisor stdin unavailable")?;
        let output = child.stdout.take().ok_or("Supervisor stdout unavailable")?;
        let bridge = Arc::new(Self {
            input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
            closing: AtomicBool::new(false),
            state: Mutex::new(None),
            _child: Mutex::new(child),
            owner,
            resources: resources.to_path_buf(),
            service: Mutex::new(None),
        });
        let target = bridge.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if line.len() > 1_048_576 {
                    break;
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(reply) = target.pending.lock().unwrap().remove(&id) {
                        let result = if message["ok"] == true {
                            Ok(message["result"].clone())
                        } else {
                            Err("Local desktop operation failed".into())
                        };
                        let _ = reply.send(result);
                    }
                } else if let Some(event) = message.get("event").and_then(Value::as_str) {
                    match event {
                        "state" => {
                            let value = message["payload"].clone();
                            *target.state.lock().unwrap() = Some(value.clone());
                            let _ = app.emit("desktop-state", &value);
                            let _ = super::update_tray(&app, &value);
                        }
                        "owner" => {
                            let mut service = target.service.lock().unwrap();
                            if service.is_none() {
                                *service = Some(message["payload"].clone());
                            }
                        }
                        "show" => super::show(&app),
                        "exit" => super::request_exit(&app),
                        _ => {}
                    }
                }
            }
            for (_, sender) in target.pending.lock().unwrap().drain() {
                let _ = sender.send(Err("Desktop supervisor closed".into()));
            }
            if !target.closing.load(Ordering::SeqCst) {
                super::diagnostics::record("desktop supervisor closed");
                let failed = json!({"bootstrap":"startupFailed","menu":{"show":"Show","exit":"Exit","servers":[]}});
                *target.state.lock().unwrap() = Some(failed.clone());
                let _ = app.emit("desktop-state", failed);
            }
        });
        Ok(bridge)
    }
    pub async fn request(&self, command: &str, payload: Value) -> Reply {
        if command == "shutdown" {
            self.closing.store(true, Ordering::SeqCst);
            if self.supervisor_exited()? {
                return self.recover_shutdown().await;
            }
        }
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let mut bytes = serde_json::to_vec(&json!({"id":id,"command":command,"payload":payload}))
            .map_err(|_| "Invalid desktop frame")?;
        if bytes.len() > 1_048_575 {
            return Err("Desktop frame limit".into());
        }
        bytes.push(b'\n');
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 128 {
                return Err("Desktop request limit".into());
            }
            pending.insert(id, sender);
        }
        let written = self.input.lock().unwrap().write_all(&bytes);
        if written.is_err() {
            self.pending.lock().unwrap().remove(&id);
            if command == "shutdown" && self.supervisor_exited()? {
                return self.recover_shutdown().await;
            }
            return Err("Desktop supervisor unavailable".into());
        }
        let result = tokio::time::timeout(Duration::from_secs(75), receiver).await;
        self.pending.lock().unwrap().remove(&id);
        let mut result = match result {
            Ok(Ok(value)) => value,
            _ => Err("Desktop operation deadline".into()),
        };
        if command == "shutdown" && result.is_err() && self.supervisor_exited()? {
            result = self.recover_shutdown().await;
        }
        if command == "shutdown" && result.is_err() {
            self.closing.store(false, Ordering::SeqCst);
        }
        result
    }
    fn supervisor_exited(&self) -> Result<bool, String> {
        self._child
            .lock()
            .unwrap()
            .try_wait()
            .map(|value| value.is_some())
            .map_err(|_| "Cannot verify supervisor exit".into())
    }
    async fn recover_shutdown(&self) -> Reply {
        let owner = self.owner.clone();
        let resources = self.resources.clone();
        let service = self.service.lock().unwrap().clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            recover_owned_supervisor(&owner, &resources, service)
        })
        .await
        .map_err(|_| "Owned supervisor recovery failed".to_string())?;
        if result.is_err() {
            self.closing.store(false, Ordering::SeqCst);
        }
        result
    }
}

fn recover_owned_supervisor(
    owner: &super::supervisor_owner::SupervisorOwner,
    resources: &Path,
    service: Option<Value>,
) -> Reply {
    if let Some(service) = service {
        let pid = service["pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or("Invalid recovery identity")?;
        let contained = owner.contains(pid)?;
        if let Err(error) = run_service_recovery(resources, &service) {
            // Only the kernel-owned descendants may be forced after graceful recovery fails.
            // An adopted external service keeps the exit gate closed on any uncertainty.
            if !contained {
                return Err(error);
            }
            super::diagnostics::record("owned service recovery requires containment cleanup");
        }
    }
    owner.drain(Duration::from_secs(30))?;
    Ok(Value::Null)
}
fn run_service_recovery(resources: &Path, service: &Value) -> Result<(), String> {
    super::integrity::verify(resources)?;
    let mut command = Command::new(resources.join("dsh/runtime").join(if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }));
    command.arg(resources.join("desktop-host.mjs")).arg("--recover-shutdown")
        .arg(json!({"resources":resources,"pid":service["pid"],"settingsFile":service["settingsFile"]}).to_string())
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(super::diagnostics::log().map(Stdio::from).unwrap_or_else(Stdio::null));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start owned service recovery")?;
    let until = std::time::Instant::now() + Duration::from_secs(45);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("Owned service recovery failed".into())
                }
            }
            Ok(None) if std::time::Instant::now() < until => {}
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Owned service recovery deadline".into());
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
