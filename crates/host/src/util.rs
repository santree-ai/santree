//! Small helpers every module shares.

use std::sync::{Mutex, MutexGuard};

use santree_remote_proto::{ErrorCode, WireError};

/// A mutex's guard, taken back from a holder that panicked rather than
/// passing the panic on.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn err(code: ErrorCode, msg: impl Into<String>) -> WireError {
    WireError::new(code, msg)
}

/// The error code of a request refused for a cap.
pub fn busy(msg: impl Into<String>) -> WireError {
    WireError::new(ErrorCode::Other("busy".into()), msg)
}

/// An I/O error as a wire error: `not_found` for a missing path, `io` for
/// everything else, its message prefixed with `what`.
pub fn io_err(e: std::io::Error, what: &str) -> WireError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        _ => ErrorCode::Io,
    };
    err(code, format!("{what}: {e}"))
}

/// Refuse an environment entry whose name the OS reads differently from us:
/// empty, or holding `=` or NUL. `("CLAUDE_CODE_CHILD_SESSION=1", "x")`
/// reaches a child as `CLAUDE_CODE_CHILD_SESSION` set to `1=x`, past every
/// `env_remove` by name. Neither the name nor the value is quoted back: either
/// may be a secret.
pub fn check_env(env: &[(String, String)], what: &str) -> Result<(), WireError> {
    match env
        .iter()
        .position(|(name, _)| name.is_empty() || name.contains(['=', '\0']))
    {
        Some(i) => Err(err(
            ErrorCode::BadRequest,
            format!("{what}[{i}] is not a valid variable name"),
        )),
        None => Ok(()),
    }
}
