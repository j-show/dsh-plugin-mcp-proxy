//! Fixed-stage diagnostics remain outside the installed runtime inventory.
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
};
fn directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        return std::env::var_os("LOCALAPPDATA")
            .map(|path| PathBuf::from(path).join("McpProxy/bootstrap"));
    }
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME").map(|path| {
            PathBuf::from(path).join("Library/Application Support/McpProxy/bootstrap")
        });
    }
    #[cfg(target_os = "linux")]
    {
        let root = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|path| PathBuf::from(path).join(".local/share"))
            })?;
        Some(root.join("mcp-proxy/bootstrap"))
    }
}
pub fn log() -> Option<File> {
    let root = directory()?;
    fs::create_dir_all(&root).ok()?;
    let file = root.join("desktop.log");
    if fs::symlink_metadata(&file).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return None;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(file).ok()
}
pub fn record(message: &str) {
    if let Some(mut file) = log() {
        let _ = writeln!(file, "mcp-proxy: {message}");
    }
}
