//! Pure domain logic for santree.
//!
//! This crate has **no** Tauri dependency on purpose: the types and the static
//! config can be unit-tested without a webview or an event loop. The Tauri
//! command layer (`src-tauri`) is a thin adapter that calls into here.

pub mod config;
pub mod diff_index;
pub mod domain;
pub mod layout;
pub mod linear;

pub use domain::*;
