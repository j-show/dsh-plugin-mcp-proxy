fn main() {
    println!("cargo:rerun-if-env-changed=MCP_PROXY_RUNTIME_SHA256");
    tauri_build::build()
}
