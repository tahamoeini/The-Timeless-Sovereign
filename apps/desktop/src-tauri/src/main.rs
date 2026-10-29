#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child as ProcessChild, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use uuid::Uuid;

enum ApiChild {
    Bundled(CommandChild),
    Development(ProcessChild),
}

impl ApiChild {
    fn kill(&mut self) {
        match self {
            Self::Bundled(child) => {
                let _ = child.kill();
            }
            Self::Development(child) => {
                let _ = child.kill();
            }
        }
    }
}

struct ApiState {
    base_url: String,
    token: String,
    child: Mutex<Option<ApiChild>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiConfig {
    base_url: String,
    token: String,
}

#[tauri::command]
fn get_api_config(state: State<'_, ApiState>) -> ApiConfig {
    ApiConfig {
        base_url: state.base_url.clone(),
        token: state.token.clone(),
    }
}

fn choose_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr().map(|address| address.port()))
        .map_err(|error| format!("Could not select a local service port: {error}"))
}

fn development_python(project_root: &Path) -> PathBuf {
    if let Some(python) = std::env::var_os("LORETHRA_DEV_PYTHON") {
        return PathBuf::from(python);
    }

    #[cfg(target_os = "windows")]
    let candidates = [
        project_root.join(".venv/Scripts/python.exe"),
        project_root.join(".venv-linux/Scripts/python.exe"),
    ];
    #[cfg(not(target_os = "windows"))]
    let candidates = [
        project_root.join(".venv/bin/python"),
        project_root.join(".venv-linux/bin/python"),
    ];

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| {
            #[cfg(target_os = "windows")]
            {
                PathBuf::from("python")
            }
            #[cfg(not(target_os = "windows"))]
            {
                PathBuf::from("python3")
            }
        })
}

fn spawn_development_api(token: &str, port: &str, data_path: &str) -> Result<ProcessChild, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir
        .join("../../..")
        .canonicalize()
        .map_err(|error| format!("Could not locate the project source for desktop development: {error}"))?;
    let backend_path = project_root.join("backend");
    if !backend_path.is_dir() {
        return Err(format!("Backend source directory is missing: {}", backend_path.display()));
    }

    Command::new(development_python(&project_root))
        .args(["-c", "from lke.api.app import main; main()"])
        .current_dir(&project_root)
        .env("PYTHONPATH", &backend_path)
        .env("LKE_API_TOKEN", token)
        .env("LKE_API_PORT", port)
        .env("LKE_DATA_DIR", data_path)
        .env("LKE_DEV_MODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start the source Python API. Install project dependencies or set LORETHRA_DEV_PYTHON: {error}"
            )
        })
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let token = Uuid::new_v4().to_string() + &Uuid::new_v4().to_string();
            let port = choose_port().map_err(std::io::Error::other)?;
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let port_text = port.to_string();
            let data_path = data_dir.to_string_lossy().to_string();

            let child = if cfg!(debug_assertions) {
                ApiChild::Development(
                    spawn_development_api(&token, &port_text, &data_path)
                        .map_err(std::io::Error::other)?,
                )
            } else {
                let command = app
                    .shell()
                    .sidecar("lke-api")?
                    .env("LKE_API_TOKEN", &token)
                    .env("LKE_API_PORT", &port_text)
                    .env("LKE_DATA_DIR", &data_path)
                    .env("LKE_DEV_MODE", "0");
                let (mut events, child) = command.spawn()?;
                tauri::async_runtime::spawn(async move {
                    while events.recv().await.is_some() {}
                });
                ApiChild::Bundled(child)
            };

            app.manage(ApiState {
                base_url: format!("http://127.0.0.1:{port}"),
                token,
                child: Mutex::new(Some(child)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_api_config])
        .build(tauri::generate_context!())
        .expect("failed to build Lorethra desktop application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<ApiState>() {
                if let Ok(mut child) = state.child.lock() {
                    if let Some(child) = child.take() {
                        let mut child = child;
                        child.kill();
                    }
                }
            }
        }
    });
}
