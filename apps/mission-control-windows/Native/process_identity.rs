use std::ffi::c_void;
use std::process::ExitCode;

type Handle = *mut c_void;

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 258;

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn GetProcessTimes(
        process: Handle,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn CloseHandle(handle: Handle) -> i32;
}

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(argument) = args.next().and_then(|arg| arg.into_string().ok()) else {
        return ExitCode::FAILURE;
    };
    let Ok(pid) = argument.parse::<u32>() else {
        return ExitCode::FAILURE;
    };
    if pid == 0 || args.next().is_some() || !argument.bytes().all(|byte| byte.is_ascii_digit()) {
        return ExitCode::FAILURE;
    }

    // Use one read-only handle for the creation time and liveness checks.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        // An open failure alone cannot distinguish a missing process from denied access.
        return ExitCode::FAILURE;
    }
    let mut creation = FileTime::default();
    let mut exit = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    let (has_time, wait) = unsafe {
        let has_time =
            GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
        let wait = WaitForSingleObject(process, 0);
        CloseHandle(process);
        (has_time, wait)
    };
    let ticks = (u64::from(creation.high) << 32) | u64::from(creation.low);
    match wait {
        WAIT_OBJECT_0 => println!("missing"),
        WAIT_TIMEOUT if has_time && ticks > 0 => println!("{pid}|{ticks}"),
        _ => return ExitCode::FAILURE,
    }
    ExitCode::SUCCESS
}
