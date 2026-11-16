#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod bridge;
mod diagnostics;
mod integrity;
mod supervisor_owner;
use bridge::Bridge;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Default)]
struct ExitGate {
    active: AtomicBool,
    allowed: AtomicBool,
}
impl ExitGate {
    fn begin(&self) -> bool {
        !self.active.swap(true, Ordering::SeqCst)
    }
    fn failed(&self) {
        self.active.store(false, Ordering::SeqCst);
    }
    fn permit(&self) {
        self.allowed.store(true, Ordering::SeqCst);
    }
}
fn administrative(args: &[String]) -> bool {
    args.iter().any(|a| {
        [
            "--help",
            "-h",
            "--stop",
            "--install",
            "--uninstall",
            "--associate",
        ]
        .contains(&a.as_str())
    }) || (args.iter().any(|a| a == "--start")
        && args
            .iter()
            .any(|a| a == "--config" || a.starts_with("--config=")))
}
fn trusted_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (["http", "https"].contains(&url.scheme()) && url.host_str() == Some("tauri.localhost"))
}
fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main"
        || !trusted_url(&window.url().map_err(|_| "Unavailable desktop origin")?)
    {
        return Err("Untrusted desktop sender".into());
    }
    Ok(())
}
fn runtime_argument(path: &std::path::Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}
fn resources(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        if let Some(value) = std::env::var_os("MCP_PROXY_DEV_RESOURCES") {
            return Ok(runtime_argument(&PathBuf::from(value)));
        }
    }
    let local = std::env::current_exe()?
        .parent()
        .ok_or("No executable directory")?
        .join("resources");
    if local.join("desktop-host.mjs").is_file() {
        return Ok(runtime_argument(&local));
    }
    #[cfg(target_os = "linux")]
    {
        let executable = std::env::current_exe()?;
        if let Some(prefix) = executable.parent().and_then(|path| path.parent()) {
            let path = prefix.join("lib/mcp-proxy/resources");
            if path.join("desktop-host.mjs").is_file() {
                return Ok(path);
            }
        }
    }
    let path = app.path().resource_dir()?.join("resources");
    if path.join("desktop-host.mjs").is_file() {
        return Ok(runtime_argument(&path));
    }
    Err("Desktop resources unavailable".into())
}
fn launch_options(
    app: &tauri::AppHandle,
    args: &[String],
    root: &PathBuf,
) -> Result<Value, Box<dyn std::error::Error>> {
    let cwd = std::env::var_os("MCP_PROXY_INVOKING_CWD")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err("Invalid invocation directory".into());
    }
    Ok(
        json!({"resources":root,"executable":runtime_argument(&std::env::current_exe()?),"cwd":runtime_argument(&cwd),
        "documents":runtime_argument(&app.path().document_dir().unwrap_or(app.path().home_dir()?.join("Documents"))),
        "args":args,"locale":sys_locale::get_locale().unwrap_or_else(||"en".into()),"registerProtocol":!cfg!(debug_assertions)}),
    )
}
fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
fn request_exit(app: &tauri::AppHandle) {
    let gate = app.state::<ExitGate>();
    if !gate.begin() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = if let Some(bridge) = app.try_state::<Arc<Bridge>>() {
            bridge.request("shutdown", Value::Null).await
        } else {
            Ok(Value::Null)
        };
        let gate = app.state::<ExitGate>();
        if result.is_ok() {
            gate.permit();
            app.exit(0);
        } else {
            gate.failed();
            let mut state = app
                .state::<Arc<Bridge>>()
                .state
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(json!({}));
            state["bootstrap"] = json!("stopFailed");
            let _ = app.emit("desktop-state", state);
            show(&app);
        }
    });
}
fn update_tray(app: &tauri::AppHandle, value: &Value) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "show",
        value["menu"]["show"].as_str().unwrap_or("Show"),
        true,
        None::<&str>,
    )?)?;
    if let Some(rows) = value["menu"]["servers"].as_array() {
        for (index, row) in rows.iter().enumerate() {
            if let Some(label) = row.as_str() {
                menu.append(&MenuItem::with_id(
                    app,
                    format!("server-{index}"),
                    label,
                    true,
                    None::<&str>,
                )?)?;
            }
        }
    }
    menu.append(&MenuItem::with_id(
        app,
        "exit",
        value["menu"]["exit"].as_str().unwrap_or("Exit"),
        true,
        None::<&str>,
    )?)?;
    if let Some(tray) = app.tray_by_id("mcp-proxy") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}
#[tauri::command]
async fn desktop_request(
    window: WebviewWindow,
    bridge: State<'_, Arc<Bridge>>,
    command: Value,
) -> Result<Value, String> {
    trusted(&window)?;
    if command["kind"] == "activate" {
        return Err("Activation is reserved for the native entry".into());
    }
    bridge.request("manage", command).await
}
#[tauri::command]
fn desktop_state(
    window: WebviewWindow,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<Option<Value>, String> {
    trusted(&window)?;
    Ok(bridge.state.lock().unwrap().clone())
}
#[tauri::command]
async fn desktop_register(
    window: WebviewWindow,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<(), String> {
    trusted(&window)?;
    bridge.request("register", Value::Null).await.map(|_| ())
}
#[tauri::command]
fn desktop_exit(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    trusted(&window)?;
    request_exit(&app);
    Ok(())
}
#[tauri::command]
async fn desktop_confirm(
    window: WebviewWindow,
    app: tauri::AppHandle,
    message: String,
) -> Result<bool, String> {
    trusted(&window)?;
    if message.len() > 8192 {
        return Err("Confirmation limit".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title("mcp-proxy")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .parent(&window)
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    receiver
        .await
        .map_err(|_| "Confirmation unavailable".into())
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let admin = administrative(&args);
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ExitGate::default())
        .invoke_handler(tauri::generate_handler![
            desktop_request,
            desktop_state,
            desktop_register,
            desktop_exit,
            desktop_confirm
        ]);
    if !admin {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let uri = argv.iter().find(|arg| arg.starts_with("mcp-proxy:"));
            if let Some(uri) = uri {
                let app = app.clone();
                let uri = uri.clone();
                tauri::async_runtime::spawn(async move {
                    let Some(bridge) = app.try_state::<Arc<Bridge>>() else {
                        show(&app);
                        return;
                    };
                    if bridge.request("activate", json!(uri)).await.is_err() {
                        show(&app);
                    }
                });
            } else {
                show(app);
            }
        }));
    }
    let application = builder
        .setup(move |app| {
            let root = resources(app.handle())?;
            integrity::verify(&root).map_err(|error| {
                diagnostics::record(&format!("runtime-integrity: {error}"));
                error
            })?;
            let options = launch_options(app.handle(), &args, &root)?;
            if admin {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut command =
                        Command::new(root.join("dsh/runtime").join(if cfg!(windows) {
                            "node.exe"
                        } else {
                            "node"
                        }));
                    command
                        .arg(root.join("desktop-host.mjs"))
                        .arg("--admin")
                        .arg(options.to_string())
                        .stdin(Stdio::null())
                        .stdout(Stdio::inherit())
                        .stderr(Stdio::inherit());
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        command.creation_flags(0x08000000);
                    }
                    let code = command
                        .status()
                        .ok()
                        .and_then(|result| result.code())
                        .unwrap_or(1);
                    handle
                        .state::<ExitGate>()
                        .allowed
                        .store(true, Ordering::SeqCst);
                    handle.exit(code);
                });
                return Ok(());
            }
            let hidden = args
                .iter()
                .any(|arg| arg == "--start" || arg.starts_with("mcp-proxy:"));
            let bridge = Bridge::start(&root, app.handle().clone())?;
            app.manage(bridge.clone());
            let mut window_builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("mcp-proxy")
                    .inner_size(1000.0, 750.0)
                    .min_inner_size(780.0, 560.0)
                    .visible(!hidden)
                    .on_navigation(trusted_url);
            #[cfg(windows)]
            {
                let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is required")?;
                window_builder = window_builder
                    .data_directory(PathBuf::from(local).join("McpProxy/bootstrap/webview"));
            }
            let window = window_builder.build()?;
            let owner = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = owner.hide();
                }
            });
            let mut tray = TrayIconBuilder::with_id("mcp-proxy")
                .tooltip("mcp-proxy")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "exit" {
                        request_exit(app)
                    } else {
                        show(app)
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            update_tray(app.handle(), &json!({}))?;
            let handle = app.handle().clone();
            if cfg!(debug_assertions) {
                let owner = app.handle().clone();
                std::thread::spawn(move || {
                    use std::io::BufRead;
                    for line in std::io::BufReader::new(std::io::stdin()).lines() {
                        let Ok(line) = line else { break };
                        if line.len() > 256 {
                            break;
                        }
                        if line == "mcp-development-stop" {
                            request_exit(&owner);
                            break;
                        }
                    }
                });
            }
            tauri::async_runtime::spawn(async move {
                if bridge.request("start", options).await.is_err() {
                    show(&handle);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!());
    let application = match application {
        Ok(app) => app,
        Err(_) => {
            diagnostics::record("desktop-initialization failed");
            std::process::exit(1)
        }
    };
    application.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<ExitGate>().allowed.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_exit(app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exit_is_coalesced_until_owned_shutdown_settles_and_can_retry_failure() {
        let gate = ExitGate::default();
        assert!(gate.begin());
        assert!(!gate.begin());
        assert!(!gate.allowed.load(Ordering::SeqCst));
        gate.failed();
        assert!(gate.begin());
        assert!(!gate.allowed.load(Ordering::SeqCst));
        gate.permit();
        assert!(gate.allowed.load(Ordering::SeqCst));
    }
    #[test]
    #[cfg(windows)]
    fn runtime_arguments_do_not_use_verbatim_windows_prefixes() {
        assert_eq!(
            runtime_argument(std::path::Path::new(r"\\?\C:\application\desktop-host.mjs")),
            PathBuf::from(r"C:\application\desktop-host.mjs")
        );
    }
    #[test]
    fn restricts_desktop_origins() {
        for value in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
        ] {
            assert!(trusted_url(&tauri::Url::parse(value).unwrap()));
        }
        for value in [
            "https://example.com",
            "http://localhost:3443",
            "file:///tmp/index.html",
            "https://tauri.localhost.example.com",
        ] {
            assert!(!trusted_url(&tauri::Url::parse(value).unwrap()));
        }
    }
    #[test]
    fn preserves_administrative_cli_dispatch() {
        assert!(administrative(&vec![
            "--config=a.json".into(),
            "--start".into()
        ]));
        assert!(administrative(&vec!["--stop".into()]));
        assert!(!administrative(&vec!["--start".into()]));
        assert!(!administrative(&vec!["mcp-proxy://associate/test".into()]));
    }
}
