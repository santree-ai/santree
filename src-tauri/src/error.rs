//! The error type every `#[tauri::command]` returns.
//!
//! Commands forward to backends that fail with rich error types (`anyhow`,
//! `sqlx`, `JoinError`, …). The frontend only ever sees a string, so [`CmdError`]
//! flattens any of them to one and serializes transparently — letting command
//! bodies use `?` instead of a trailing `.map_err(|e| e.to_string())` on every
//! line. It (de)serializes and types (via specta) as a bare `string`, so
//! `bindings.ts` keeps `Result<T, string>`.
//!
//! The blanket `From<E: Display>` is what makes `?` work for every backend error.
//! It does *not* conflict with the std reflexive `From<T> for T` because
//! `CmdError` deliberately does not implement `Display` — so `E = CmdError` never
//! satisfies the bound.

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(transparent)]
#[specta(transparent)]
pub struct CmdError(pub String);

impl<E: std::fmt::Display> From<E> for CmdError {
    fn from(e: E) -> Self {
        Self(e.to_string())
    }
}

/// The return type of a fallible command. The frontend receives the `Err` string.
pub type CmdResult<T> = Result<T, CmdError>;
