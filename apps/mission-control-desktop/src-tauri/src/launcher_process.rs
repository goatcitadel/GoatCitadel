use std::{
    io::{self, Read},
    process::{Child, Command, Output, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};

static STATUS_READ: Mutex<()> = Mutex::new(());
const MAX_PIPE_BYTES: u64 = 8 * 1024 * 1024;

/// Status probes own an OS process group and an absolute deadline, including
/// pipes retained by descendants. This owner is never used for runtime launch.
pub fn output(command: &mut Command, deadline: Duration) -> io::Result<Output> {
    let _read = STATUS_READ.try_lock().map_err(|_| {
        io::Error::new(
            io::ErrorKind::WouldBlock,
            "A desktop status read is already in progress.",
        )
    })?;
    let started = Instant::now();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000004); // CREATE_NO_WINDOW | CREATE_SUSPENDED; assign job before execution.
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let group = match ProcessGroup::new(&child) {
        Ok(group) => group,
        Err(error) => {
            let _ = reap_direct(&mut child);
            return Err(error);
        }
    };
    let mut owned = LauncherChild {
        child,
        group,
        cleaned: false,
    };
    #[cfg(windows)]
    owned.group.resume(&owned.child)?;
    let stdout = owned
        .child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing status stdout pipe."))?;
    let stderr = owned
        .child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Missing status stderr pipe."))?;
    let (sender, receiver) = mpsc::channel();
    let read_pipe = |pipe: Box<dyn Read + Send>,
                     sender: mpsc::Sender<(bool, io::Result<Vec<u8>>)>,
                     is_stdout| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe
                .take(MAX_PIPE_BYTES + 1)
                .read_to_end(&mut bytes)
                .and_then(|_| {
                    if bytes.len() as u64 > MAX_PIPE_BYTES {
                        Err(io::Error::other(
                            "Desktop status output exceeded its limit.",
                        ))
                    } else {
                        Ok(bytes)
                    }
                });
            let _ = sender.send((is_stdout, result));
        })
    };
    let readers = [
        read_pipe(Box::new(stdout), sender.clone(), true),
        read_pipe(Box::new(stderr), sender, false),
    ];
    let mut stdout = None;
    let mut stderr = None;
    let result = loop {
        if started.elapsed() >= deadline {
            break Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Desktop status launcher exceeded its deadline.",
            ));
        }
        let status = match owned.child.try_wait() {
            Ok(status) => status,
            Err(error) => break Err(error),
        };
        if let (Some(status), true, true) = (status, stdout.is_some(), stderr.is_some()) {
            break Ok(Output {
                status,
                stdout: stdout.take().expect("stdout was checked present"),
                stderr: stderr.take().expect("stderr was checked present"),
            });
        }
        let remaining = deadline.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Desktop status launcher exceeded its deadline.",
            ));
        }
        match receiver.recv_timeout(remaining.min(Duration::from_millis(5))) {
            Ok((is_stdout, Ok(bytes))) => {
                if is_stdout {
                    stdout = Some(bytes);
                } else {
                    stderr = Some(bytes);
                }
            }
            Ok((_, Err(error))) => break Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Readers have finished; the direct process can still be exiting.
                thread::sleep(remaining.min(Duration::from_millis(5)));
            }
        }
    };
    let mut cleanup = owned.cleanup();
    // Terminate the group/job before waiting for pipe readers. Even failed OS
    // cleanup has a bound; it must never turn the status deadline into a join hang.
    let pipe_deadline = Instant::now() + Duration::from_millis(500);
    while readers.iter().any(|reader| !reader.is_finished()) && Instant::now() < pipe_deadline {
        thread::sleep(Duration::from_millis(5));
    }
    for reader in readers {
        if reader.is_finished() {
            let _ = reader.join();
        } else {
            cleanup = Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Status pipe cleanup did not finish.",
            ));
        }
    }
    match (result, cleanup) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(output), Ok(())) => Ok(output),
    }
}

fn reap_direct(child: &mut Child) -> io::Result<()> {
    if child.try_wait()?.is_none() {
        child.kill()?;
    }
    let until = Instant::now() + Duration::from_millis(500);
    while child.try_wait()?.is_none() {
        if Instant::now() >= until {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Status launcher did not exit after termination.",
            ));
        }
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}
struct LauncherChild {
    child: Child,
    group: ProcessGroup,
    cleaned: bool,
}
impl LauncherChild {
    fn cleanup(&mut self) -> io::Result<()> {
        if self.cleaned {
            return Ok(());
        }
        self.cleaned = true;
        let group_result = self.group.terminate();
        reap_direct(&mut self.child)?;
        group_result
    }
}
impl Drop for LauncherChild {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

#[cfg(unix)]
struct ProcessGroup {
    pid: i32,
}
#[cfg(unix)]
impl ProcessGroup {
    fn new(child: &Child) -> io::Result<Self> {
        Ok(Self {
            pid: i32::try_from(child.id())
                .map_err(|_| io::Error::other("Invalid launcher process id."))?,
        })
    }
    fn terminate(&self) -> io::Result<()> {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // SAFETY: process_group(0) established this task-owned child's group before exec.
        if unsafe { kill(-self.pid, 9) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(3) {
            Ok(())
        } else {
            Err(error)
        } // ESRCH: already gone.
    }
}

#[cfg(windows)]
use windows_job::ProcessGroup;
#[cfg(windows)]
mod windows_job {
    use super::*;
    use std::{
        ffi::c_void,
        mem::{size_of, zeroed},
        os::windows::io::AsRawHandle,
        ptr,
    };
    type Handle = *mut c_void;
    #[repr(C)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working: usize,
        max_working: usize,
        active_processes: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    struct ThreadEntry {
        size: u32,
        usage: u32,
        thread_id: u32,
        owner_pid: u32,
        base_priority: i32,
        delta_priority: i32,
        flags: u32,
    }
    #[repr(C)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Thread32First(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
        fn Thread32Next(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
        fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> Handle;
        fn GetProcessIdOfThread(thread: Handle) -> u32;
        fn ResumeThread(thread: Handle) -> u32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    }
    pub(super) struct ProcessGroup {
        handle: Handle,
    }
    impl ProcessGroup {
        pub(super) fn new(child: &Child) -> io::Result<Self> {
            // SAFETY: null security/name parameters request a private unnamed job.
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let group = Self { handle };
            // SAFETY: this repr(C) struct contains only zero-valid integer fields.
            let mut limits: ExtendedLimits = unsafe { zeroed() };
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                                         // SAFETY: the job and child's process handle are owned/live; info size matches ABI.
            if unsafe {
                SetInformationJobObject(
                    handle,
                    9,
                    &limits as *const _ as *const c_void,
                    size_of::<ExtendedLimits>() as u32,
                )
            } == 0
                || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(group)
        }
        pub(super) fn resume(&self, child: &Child) -> io::Result<()> {
            // CREATE_SUSPENDED prevents all child code until this private job owns it.
            // Toolhelp returns thread IDs, then the opened handle is rechecked against
            // this still-live Child PID before resuming. Never touch a foreign thread.
            // SAFETY: the requested snapshot is read-only, and every returned handle
            // below has one RAII owner. THREADENTRY32 matches the documented Win32 ABI.
            let snapshot = unsafe { CreateToolhelp32Snapshot(4, 0) }; // TH32CS_SNAPTHREAD
            if snapshot as isize == -1 {
                return Err(io::Error::last_os_error());
            }
            let snapshot = OwnedHandle(snapshot);
            let mut entry = ThreadEntry {
                size: size_of::<ThreadEntry>() as u32,
                usage: 0,
                thread_id: 0,
                owner_pid: 0,
                base_priority: 0,
                delta_priority: 0,
                flags: 0,
            };
            let mut found = unsafe { Thread32First(snapshot.0, &mut entry) } != 0;
            while found {
                if entry.owner_pid == child.id() {
                    // SAFETY: request only suspend/resume plus limited query on the
                    // enumerated thread; GetProcessIdOfThread revalidates ownership.
                    let thread = unsafe { OpenThread(0x0002 | 0x0800, 0, entry.thread_id) };
                    if thread.is_null() {
                        return Err(io::Error::last_os_error());
                    }
                    let thread = OwnedHandle(thread);
                    if unsafe { GetProcessIdOfThread(thread.0) } != child.id()
                        || unsafe { WaitForSingleObject(child.as_raw_handle(), 0) } != 258
                    {
                        return Err(io::Error::other(
                            "Status launcher thread ownership changed.",
                        ));
                    }
                    // SAFETY: only this task-created, job-owned process's initial
                    // suspended thread is eligible. No arbitrary PID/thread resume.
                    return match unsafe { ResumeThread(thread.0) } {
                        1 => Ok(()),
                        u32::MAX => Err(io::Error::last_os_error()),
                        _ => Err(io::Error::other(
                            "Unexpected status launcher suspend count.",
                        )),
                    };
                }
                entry.size = size_of::<ThreadEntry>() as u32;
                found = unsafe { Thread32Next(snapshot.0, &mut entry) } != 0;
            }
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Status launcher initial thread was not found.",
            ))
        }
        pub(super) fn terminate(&self) -> io::Result<()> {
            // SAFETY: this instance retains its private task-owned job handle until Drop.
            if unsafe { TerminateJobObject(self.handle, 1) } != 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }
    struct OwnedHandle(Handle);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: this owns one valid snapshot/thread handle and closes it once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    impl Drop for ProcessGroup {
        fn drop(&mut self) {
            // SAFETY: this is the single owner of the live job handle.
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs, thread,
        time::{Instant, SystemTime, UNIX_EPOCH},
    };

    // The fixtures share the production single-flight status owner.
    static OUTPUT_FIXTURE: Mutex<()> = Mutex::new(());

    #[test]
    fn launcher_fixture() {
        let Some(marker) = env::var_os("GOATCITADEL_STATUS_TEST_MARKER") else {
            return;
        };
        if env::var_os("GOATCITADEL_STATUS_TEST_DESCENDANT").is_some() {
            let mut child = fixture_command();
            child.env_remove("GOATCITADEL_STATUS_TEST_DESCENDANT");
            child.spawn().expect("fixture descendant");
            return;
        }
        if env::var_os("GOATCITADEL_STATUS_TEST_IMMEDIATE").is_none() {
            thread::sleep(Duration::from_millis(350));
        }
        fs::write(marker, b"late side effect").expect("fixture marker");
    }

    fn fixture_command() -> Command {
        let mut command = Command::new(env::current_exe().expect("test executable"));
        command.args(["--nocapture", "launcher_fixture"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW: fixture descendants also stay hidden.
        }
        command
    }

    fn check_deadline(descendant: bool) {
        let _fixture = OUTPUT_FIXTURE.lock().expect("status fixture lock");
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let marker = env::temp_dir().join(format!(
            "goatcitadel-status-deadline-{}-{stamp}",
            std::process::id()
        ));
        let mut command = fixture_command();
        command.env("GOATCITADEL_STATUS_TEST_MARKER", &marker);
        if descendant {
            command.env("GOATCITADEL_STATUS_TEST_DESCENDANT", "1");
        }
        let start = Instant::now();
        let result = output(&mut command, Duration::from_millis(60));
        let elapsed = start.elapsed();
        thread::sleep(Duration::from_millis(400));
        let marker_exists = marker.exists();
        if marker_exists {
            fs::remove_file(&marker).expect("remove task-owned marker");
        }
        assert!(
            matches!(&result, Err(error) if error.kind() == io::ErrorKind::TimedOut),
            "expected native deadline, got {result:?}"
        );
        assert!(
            elapsed < Duration::from_millis(300),
            "native wait exceeded deadline: {elapsed:?}"
        );
        assert!(
            !marker_exists,
            "timed-out launcher/descendant was not terminated"
        );
    }

    #[test]
    fn deadline_reaps_the_launcher() {
        check_deadline(false);
    }

    #[test]
    fn deadline_reaps_descendant_holding_pipes_after_parent_exit() {
        check_deadline(true);
    }

    #[cfg(windows)]
    #[test]
    fn windows_status_child_cannot_execute_before_job_ownership() {
        use std::os::windows::process::CommandExt;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let marker = env::temp_dir().join(format!(
            "goatcitadel-status-suspended-{}-{stamp}",
            std::process::id()
        ));
        let mut command = fixture_command();
        command
            .env("GOATCITADEL_STATUS_TEST_MARKER", &marker)
            .env("GOATCITADEL_STATUS_TEST_IMMEDIATE", "1")
            .creation_flags(0x08000004)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("suspended task-owned fixture");
        let group = ProcessGroup::new(&child).unwrap_or_else(|error| {
            let _ = reap_direct(&mut child);
            panic!("private job could not own suspended fixture: {error}");
        });
        let mut owned = LauncherChild {
            child,
            group,
            cleaned: false,
        };
        thread::sleep(Duration::from_millis(80));
        let ran_before_resume = marker.exists();
        owned
            .group
            .resume(&owned.child)
            .expect("resume only after job ownership");
        let until = Instant::now() + Duration::from_secs(2);
        while owned.child.try_wait().expect("fixture status").is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        owned.cleanup().expect("reap owned fixture");
        let ran_after_resume = marker.exists();
        if ran_after_resume {
            fs::remove_file(marker).expect("remove owned marker");
        }
        assert!(
            !ran_before_resume,
            "fixture ran while it was required to remain suspended"
        );
        assert!(
            ran_after_resume,
            "fixture did not execute after its job owner resumed it"
        );
    }
    #[test]
    fn successful_status_preserves_output_and_exit_status() {
        let _fixture = OUTPUT_FIXTURE.lock().expect("status fixture lock");
        let mut command = fixture_command();
        let result = output(&mut command, Duration::from_secs(2)).expect("fixture completes");
        assert!(result.status.success());
        assert!(String::from_utf8_lossy(&result.stdout).contains("launcher_fixture"));
    }
}
