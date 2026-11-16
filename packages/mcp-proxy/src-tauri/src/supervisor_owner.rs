//! Keep the supervisor's descendants owned even after the supervisor crashes.
use std::{
    process::{Child, Command},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub struct SupervisorOwner {
    drained: AtomicBool,
    uncertain: AtomicBool,
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
                uncertain: AtomicBool::new(false),
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
                    uncertain: AtomicBool::new(false),
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
    fn alive(&self) -> Result<Option<bool>, String> {
        if self.drained.load(Ordering::SeqCst) {
            return Ok(Some(false));
        }
        let alive = self.probe_alive()?;
        if alive == Some(false) {
            self.drained.store(true, Ordering::SeqCst);
        }
        if alive.is_none() {
            self.uncertain.store(true, Ordering::SeqCst);
        }
        Ok(alive)
    }
    fn probe_alive(&self) -> Result<Option<bool>, String> {
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
            Ok(Some(info.ActiveProcesses != 0))
        }
        #[cfg(unix)]
        {
            if unsafe { kill(-self.group, 0) } != 0 {
                match std::io::Error::last_os_error().raw_os_error() {
                    Some(3) => return Ok(Some(false)),
                    Some(1) => return Ok(None),
                    _ => {}
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
                        return Ok(Some(true));
                    }
                }
                Ok(Some(false))
            }
            #[cfg(not(target_os = "linux"))]
            {
                Ok(Some(true))
            }
        }
    }
    fn terminate(&self) -> Result<bool, String> {
        if self.drained.load(Ordering::SeqCst) {
            return Ok(true);
        }
        #[cfg(windows)]
        if unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job as _, 1) }
            == 0
        {
            return Err("Cannot stop owned supervisor processes".into());
        }
        #[cfg(unix)]
        if unsafe { kill(-self.group, 9) } != 0 {
            return self.unix_termination_error(std::io::Error::last_os_error().raw_os_error());
        }
        Ok(true)
    }
    #[cfg(any(unix, test))]
    fn unix_termination_error(&self, error: Option<i32>) -> Result<bool, String> {
        match error {
            Some(3) => {
                self.drained.store(true, Ordering::SeqCst);
                Ok(true)
            }
            Some(1) => {
                self.uncertain.store(true, Ordering::SeqCst);
                Ok(false)
            }
            _ => Err("Cannot stop owned supervisor group".into()),
        }
    }
    pub fn drain(&self, grace: Duration) -> Result<(), String> {
        drain_scope(
            || self.alive(),
            || self.terminate(),
            grace,
            Duration::from_secs(5),
            self.uncertain.load(Ordering::SeqCst),
        )
    }
}
// Called only after the supervisor's direct-child exit has been confirmed.
fn drain_scope(
    mut probe: impl FnMut() -> Result<Option<bool>, String>,
    mut terminate: impl FnMut() -> Result<bool, String>,
    grace: Duration,
    reap: Duration,
    mut uncertain: bool,
) -> Result<(), String> {
    let force_at = Instant::now() + grace;
    let deadline = force_at + reap;
    let mut attempted = false;
    loop {
        let presence = probe()?;
        if presence == Some(false) {
            return Ok(());
        }
        if presence.is_none() {
            uncertain = true;
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("Owned supervisor processes still running or unverified".into());
        }
        if now >= force_at && !attempted && !uncertain && presence == Some(true) {
            attempted = true;
            if !terminate()? {
                uncertain = true;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
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
            if self.alive() == Ok(Some(true)) && !self.uncertain.load(Ordering::SeqCst) {
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
    fn signal_side_absence_is_terminal_before_any_reused_group_can_be_observed() {
        let owner = SupervisorOwner {
            drained: AtomicBool::new(false),
            uncertain: AtomicBool::new(false),
            #[cfg(windows)]
            job: 0,
            #[cfg(unix)]
            group: i32::MAX,
        };
        assert_eq!(owner.unix_termination_error(Some(3)), Ok(true));
        assert!(owner.drained.load(Ordering::SeqCst));
        assert_eq!(owner.alive(), Ok(Some(false)));
        assert_eq!(owner.terminate(), Ok(true));
    }
    #[test]
    fn unknown_presence_waits_for_authoritative_absence_without_signalling() {
        let observations = std::cell::Cell::new(0);
        drain_scope(
            || {
                observations.set(observations.get() + 1);
                Ok(if observations.get() == 1 {
                    None
                } else {
                    Some(false)
                })
            },
            || panic!("unknown scope must not be signalled"),
            Duration::ZERO,
            Duration::from_millis(100),
            false,
        )
        .unwrap();
        assert!(observations.get() > 1);
    }
    #[test]
    fn persistent_unknown_presence_expires_without_signalling() {
        assert!(drain_scope(
            || Ok(None),
            || panic!("unknown scope must not be signalled"),
            Duration::ZERO,
            Duration::from_millis(30),
            false
        )
        .is_err());
    }
    #[test]
    fn newly_visible_group_after_uncertainty_is_not_signalled() {
        let observations = std::cell::Cell::new(0);
        assert!(drain_scope(
            || {
                observations.set(observations.get() + 1);
                Ok(if observations.get() == 1 {
                    None
                } else {
                    Some(true)
                })
            },
            || panic!("unanchored scope must not be signalled"),
            Duration::ZERO,
            Duration::from_millis(30),
            false
        )
        .is_err());
    }
    #[test]
    fn denied_signal_is_not_retried_and_requires_later_absence() {
        let present = std::cell::Cell::new(true);
        let signals = std::cell::Cell::new(0);
        drain_scope(
            || Ok(Some(present.get())),
            || {
                signals.set(signals.get() + 1);
                present.set(false);
                Ok(false)
            },
            Duration::ZERO,
            Duration::from_millis(100),
            false,
        )
        .unwrap();
        assert_eq!(signals.get(), 1);
    }
    #[test]
    fn previous_uncertainty_remains_in_force_on_exit_retry() {
        assert!(drain_scope(
            || Ok(Some(true)),
            || panic!("retry cannot recover a lost anchor"),
            Duration::ZERO,
            Duration::from_millis(30),
            true
        )
        .is_err());
    }
    #[test]
    fn other_probe_failures_are_preserved() {
        assert_eq!(
            drain_scope(
                || Err("inspection failed".into()),
                || panic!("failed scope must not be signalled"),
                Duration::ZERO,
                Duration::from_millis(100),
                false
            ),
            Err("inspection failed".into())
        );
    }
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
        assert_eq!(owner.alive().unwrap(), Some(true));
        owner.drain(Duration::from_millis(40)).unwrap();
        assert_eq!(owner.alive().unwrap(), Some(false));
    }
}
