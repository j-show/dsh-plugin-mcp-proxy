//! Keep the supervisor's descendants owned even after the supervisor crashes.
use std::{
    process::{Child, Command},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub struct SupervisorOwner {
    drained: AtomicBool,
    #[cfg(windows)]
    job: usize,
    #[cfg(unix)]
    group: i32,
}
impl SupervisorOwner {
    pub fn prepare(command: &mut Command) {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        let _ = command;
    }
    pub fn attach(child: &Child) -> Result<Self, String> {
        #[cfg(unix)]
        {
            Ok(Self {
                group: child.id() as i32,
                drained: AtomicBool::new(false),
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err("Cannot create supervisor containment".into());
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(job, child.as_raw_handle()) == 0
                {
                    CloseHandle(job);
                    return Err("Cannot contain supervisor process".into());
                }
                Ok(Self {
                    job: job as usize,
                    drained: AtomicBool::new(false),
                })
            }
        }
    }
    pub fn contains(&self, pid: u32) -> Result<bool, String> {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::{
                Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER},
                System::{
                    JobObjects::IsProcessInJob,
                    Threading::{OpenProcess, PROCESS_QUERY_INFORMATION},
                },
            };
            let process = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
            if process.is_null() {
                return if GetLastError() == ERROR_INVALID_PARAMETER {
                    Ok(false)
                } else {
                    Err("Cannot verify recovery process ownership".into())
                };
            }
            let mut belongs = 0;
            let result = IsProcessInJob(process, self.job as _, &mut belongs);
            CloseHandle(process);
            if result == 0 {
                Err("Cannot verify recovery process ownership".into())
            } else {
                Ok(belongs != 0)
            }
        }
        #[cfg(unix)]
        {
            let group = unsafe { getpgid(pid as i32) };
            if group < 0 {
                if std::io::Error::last_os_error().raw_os_error() == Some(3) {
                    return Ok(false);
                }
                return Err("Cannot verify recovery process ownership".into());
            }
            Ok(group == self.group)
        }
    }
    fn alive(&self) -> Result<bool, String> {
        if self.drained.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let alive = self.probe_alive()?;
        if !alive {
            self.drained.store(true, Ordering::SeqCst);
        }
        Ok(alive)
    }
    fn probe_alive(&self) -> Result<bool, String> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::*;
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe {
                QueryInformationJobObject(
                    self.job as _,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err("Cannot inspect owned supervisor processes".into());
            }
            Ok(info.ActiveProcesses != 0)
        }
        #[cfg(unix)]
        {
            if unsafe { kill(-self.group, 0) } != 0 {
                if std::io::Error::last_os_error().raw_os_error() == Some(3) {
                    return Ok(false);
                }
                return Err("Cannot inspect owned supervisor group".into());
            }
            #[cfg(target_os = "linux")]
            {
                // A reparented zombie is already dead; PID 1 may reap it later.
                for entry in std::fs::read_dir("/proc")
                    .map_err(|_| "Cannot inspect owned supervisor group")?
                    .flatten()
                {
                    if !entry
                        .file_name()
                        .to_string_lossy()
                        .bytes()
                        .all(|b| b.is_ascii_digit())
                    {
                        continue;
                    }
                    let stat = match std::fs::read_to_string(entry.path().join("stat")) {
                        Ok(stat) => stat,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(_) => return Err("Cannot inspect supervisor group member".into()),
                    };
                    let Some((_, fields)) = stat.rsplit_once(") ") else {
                        return Err("Invalid supervisor group member".into());
                    };
                    let fields: Vec<_> = fields.split_whitespace().collect();
                    if fields.get(2).and_then(|s| s.parse::<i32>().ok()) == Some(self.group)
                        && fields.first() != Some(&"Z")
                    {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(true)
            }
        }
    }
    fn terminate(&self) -> Result<(), String> {
        #[cfg(windows)]
        if unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job as _, 1) }
            == 0
        {
            return Err("Cannot stop owned supervisor processes".into());
        }
        #[cfg(unix)]
        if unsafe { kill(-self.group, 9) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(3)
        {
            return Err("Cannot stop owned supervisor group".into());
        }
        Ok(())
    }
    fn wait(&self, timeout: Duration) -> Result<bool, String> {
        let until = Instant::now() + timeout;
        loop {
            if !self.alive()? {
                return Ok(true);
            }
            if Instant::now() >= until {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    pub fn drain(&self, grace: Duration) -> Result<(), String> {
        if self.wait(grace)? {
            return Ok(());
        }
        self.terminate()?;
        if self.wait(Duration::from_secs(5))? {
            Ok(())
        } else {
            Err("Owned supervisor processes still running".into())
        }
    }
}
#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
    fn getpgid(pid: i32) -> i32;
}
impl Drop for SupervisorOwner {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job as _);
        }
        #[cfg(unix)]
        {
            if self.alive() == Ok(true) {
                let _ = self.terminate();
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    #[test]
    fn owned_child_fixture() {
        match std::env::var("MCP_PROXY_OWNER_FIXTURE").as_deref() {
            Ok("descendant") => std::thread::sleep(Duration::from_secs(60)),
            Ok("root") => {
                std::io::stdin().read_exact(&mut [0]).unwrap();
                let _child = Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "supervisor_owner::tests::owned_child_fixture",
                        "--nocapture",
                    ])
                    .env("MCP_PROXY_OWNER_FIXTURE", "descendant")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap();
                println!("owned descendant ready");
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_secs(60));
            }
            _ => {}
        }
    }
    #[test]
    fn drains_descendants_after_the_supervisor_exits() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "supervisor_owner::tests::owned_child_fixture",
                "--nocapture",
            ])
            .env("MCP_PROXY_OWNER_FIXTURE", "root")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        SupervisorOwner::prepare(&mut command);
        let mut child = command.spawn().unwrap();
        let owner = SupervisorOwner::attach(&child).unwrap();
        assert!(owner.contains(child.id()).unwrap());
        assert!(!owner.contains(std::process::id()).unwrap());
        child.stdin.take().unwrap().write_all(b"g").unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
            if line.contains("owned descendant ready") {
                break;
            }
        }
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(owner.alive().unwrap());
        owner.drain(Duration::from_millis(40)).unwrap();
        assert!(!owner.alive().unwrap());
    }
}
