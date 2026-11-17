//! Verify installed resources against a digest embedded in the executable at build time.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::Path};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inventory {
    version: u32,
    node_version: String,
    files: Vec<Entry>,
}
#[derive(Deserialize)]
struct Entry {
    path: String,
    size: u64,
    sha256: String,
}
fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
fn collect(root: &Path, directory: &Path, names: &mut BTreeSet<String>) -> Result<(), String> {
    let metadata = fs::symlink_metadata(directory).map_err(|_| "Runtime directory unavailable")?;
    if metadata.file_type().is_symlink() {
        return Err("Linked runtime content".into());
    }
    for entry in fs::read_dir(directory).map_err(|_| "Runtime directory unreadable")? {
        let entry = entry.map_err(|_| "Runtime entry unreadable")?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| "Runtime entry unavailable")?;
        if metadata.file_type().is_symlink() {
            return Err("Linked runtime content".into());
        }
        if metadata.is_dir() {
            collect(root, &path, names)?;
        } else if metadata.is_file() {
            let name = path
                .strip_prefix(root)
                .map_err(|_| "Runtime path escaped root")?
                .to_string_lossy()
                .replace('\\', "/");
            if name != "mcp-runtime.json" {
                names.insert(name);
            }
        } else {
            return Err("Unsupported runtime entry".into());
        }
    }
    Ok(())
}
pub fn verify(root: &Path) -> Result<(), String> {
    let expected = option_env!("MCP_PROXY_RUNTIME_SHA256");
    if expected.is_none() && cfg!(debug_assertions) {
        return Ok(());
    }
    let expected = expected.ok_or("Missing compiled runtime digest")?;
    let bytes =
        fs::read(root.join("mcp-runtime.json")).map_err(|_| "Runtime inventory unavailable")?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected {
        return Err("Runtime inventory digest changed".into());
    }
    let inventory: Inventory =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid runtime inventory")?;
    if inventory.version != 1 || !inventory.node_version.starts_with("22.") {
        return Err("Unsupported runtime inventory".into());
    }
    let mut actual = BTreeSet::new();
    collect(root, root, &mut actual)?;
    let listed: BTreeSet<String> = inventory
        .files
        .iter()
        .map(|entry| entry.path.clone())
        .collect();
    if actual != listed || listed.len() != inventory.files.len() {
        return Err("Runtime file set changed".into());
    }
    for entry in inventory.files {
        if !valid_path(&entry.path) {
            return Err("Invalid runtime path".into());
        }
        let bytes = fs::read(root.join(entry.path)).map_err(|_| "Runtime file unavailable")?;
        if bytes.len() as u64 != entry.size
            || format!("{:x}", Sha256::digest(&bytes)) != entry.sha256
        {
            return Err("Runtime file digest changed".into());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_escaped_and_platform_ambiguous_paths() {
        for path in [
            "../node", "/node", "a//node", "a/./node", "a\\node", "C:/node", "a\n/node",
        ] {
            assert!(!valid_path(path));
        }
        assert!(valid_path(
            "dsh/node_modules/@jshow/app-mcp-proxy/lib/index.js"
        ));
    }
}
