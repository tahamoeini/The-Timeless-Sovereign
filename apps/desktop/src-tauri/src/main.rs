#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::net::TcpListener;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use uuid::Uuid;

struct ApiState {
    base_url: String,
    token: String,
    child: Mutex<Option<CommandChild>>,
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

            let command = app
                .shell()
                .sidecar("lke-api")?
                .env("LKE_API_TOKEN", &token)
                .env("LKE_API_PORT", &port_text)
                .env("LKE_DATA_DIR", &data_path);
            let (mut events, child) = command.spawn()?;
            tauri::async_runtime::spawn(async move {
                while events.recv().await.is_some() {}
            });

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
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}
