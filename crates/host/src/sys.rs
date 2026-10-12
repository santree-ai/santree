//! What `hello` says about this machine and its user, and the boot id.

use std::io::Read;

pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length, which bounds the write.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let len = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..len]).into_owned()
}

/// `$USER` and `$HOME`, falling back to the passwd entry of the running uid.
pub fn user_and_home() -> (String, String) {
    let pw = Passwd::current();
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    (
        env("USER").or(pw.name).unwrap_or_default(),
        env("HOME").or(pw.dir).unwrap_or_default(),
    )
}

/// 16 hex digits from the kernel's CSPRNG, fresh per host: hook `seq`
/// restarts with each host, and this tells a client its cursor is stale. Two
/// hosts in one process (tests) never share one; should `/dev/urandom` be
/// unreadable, the clock and a per-process counter stand in.
pub fn new_boot_id() -> String {
    let mut bytes = [0u8; 8];
    let read = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes));
    if let Err(e) = read {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        log::warn!("reading /dev/urandom: {e}; the boot id falls back to the clock");
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        bytes = (nanos ^ NEXT.fetch_add(1, Ordering::Relaxed).rotate_left(48)).to_be_bytes();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

struct Passwd {
    name: Option<String>,
    dir: Option<String>,
}

impl Passwd {
    fn current() -> Self {
        // SAFETY: an all-zero `passwd` is a valid out-parameter.
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let mut buf = vec![0 as libc::c_char; 16 * 1024];
        // SAFETY: getpwuid_r writes into `pwd` and `buf` (valid for their
        // sizes) and sets `result` to `&pwd` or null.
        let rc = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                &mut pwd,
                buf.as_mut_ptr(),
                buf.len(),
                &mut result,
            )
        };
        if rc != 0 || result.is_null() {
            return Self {
                name: None,
                dir: None,
            };
        }
        let text = |p: *const libc::c_char| {
            // SAFETY: on success both fields are null or point at
            // NUL-terminated strings inside `buf`, which outlives this call.
            (!p.is_null()).then(|| {
                unsafe { std::ffi::CStr::from_ptr(p) }
                    .to_string_lossy()
                    .into_owned()
            })
        };
        Self {
            name: text(pwd.pw_name),
            dir: text(pwd.pw_dir),
        }
    }
}
