//! `santree-server serve --run-dir DIR [--log-file PATH] [--ready-fd FD]`
//! `santree-server version [--json]`
//!
//! `--ready-fd` is one end of a unix socketpair the launcher keeps the other
//! end of; a code-signed server requires it and serves only when the peer on
//! it is santree.app. A ready fd that is not an unnamed socketpair end (a
//! client of a named socket) is refused, signed or not. `serve` exits 20 when
//! another server holds the endpoint, 21 when its launcher is not santree.app
//! or its ready fd is not a socketpair end, 22 when a release
//! build can't confirm its own signature, 1 on any other failure to start.
//!
//! No `status` or `stop` verb: anything in a santree terminal could run one,
//! and a stop anyone can run is a kill switch for every session. The app
//! asks the server itself, over the socket only it may use.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use santree_server::{features, serve, Idle, ServeOptions, ENDPOINT_CHECK, REVISION};

/// The shortest a hidden timing flag can make a window.
const MIN_WINDOW_MS: u64 = 50;

const USAGE: &str = "usage: santree-server serve --run-dir DIR [--log-file PATH] [--ready-fd FD]
       santree-server version [--json]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => match parse_serve(&args[1..]) {
            Ok(opts) => match serve(opts) {
                Ok(served) => ExitCode::from(served.exit_code() as u8),
                Err(e) => {
                    log::error!("can't serve: {e:#}");
                    log::logger().flush();
                    eprintln!("santree-server: {e:#}");
                    ExitCode::FAILURE
                }
            },
            Err(e) => usage(&e),
        },
        Some("version") => match &args[1..] {
            [] => {
                println!(
                    "santree-server {} revision {REVISION} protocol {}",
                    env!("CARGO_PKG_VERSION"),
                    santree_host::proto::PROTOCOL_VERSION
                );
                ExitCode::SUCCESS
            }
            [json] if json == "--json" => {
                let out = serde_json::json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "revision": REVISION,
                    "protocol": santree_host::proto::PROTOCOL_VERSION,
                    "features": features(),
                });
                println!("{out}");
                ExitCode::SUCCESS
            }
            [other, ..] => usage(&format!("unknown argument {other:?}")),
        },
        Some(other) => usage(&format!("unknown command {other:?}")),
        None => usage("no command"),
    }
}

fn usage(why: &str) -> ExitCode {
    eprintln!("santree-server: {why}\n{USAGE}");
    ExitCode::from(2)
}

fn parse_serve(args: &[String]) -> Result<ServeOptions, String> {
    let mut run_dir = None;
    let mut log_file = None;
    let mut ready_fd = None;
    let mut idle = Idle::default();
    let mut endpoint_check = ENDPOINT_CHECK;
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = || {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        // The hidden flags exist for tests' short windows; none may go below
        // 50 ms (a window that short is a busy loop, not a test).
        let millis = |v: String| {
            v.parse::<u64>()
                .map(|ms| Duration::from_millis(ms.max(MIN_WINDOW_MS)))
                .map_err(|_| format!("{flag}: {v:?} is not a number of milliseconds"))
        };
        match flag.as_str() {
            "--run-dir" => run_dir = Some(PathBuf::from(value()?)),
            "--log-file" => log_file = Some(PathBuf::from(value()?)),
            "--ready-fd" => {
                let v = value()?;
                ready_fd = Some(
                    v.parse()
                        .map_err(|_| format!("--ready-fd: {v:?} is not an fd"))?,
                );
            }
            // Hidden: the tests' short idle windows.
            "--idle-grace-ms" => idle.grace = millis(value()?)?,
            "--idle-initial-ms" => idle.initial = millis(value()?)?,
            "--reap-after-ms" => idle.reap_after = millis(value()?)?,
            "--endpoint-check-ms" => endpoint_check = millis(value()?)?,
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(ServeOptions {
        run_dir: run_dir.ok_or("serve needs --run-dir")?,
        log_file,
        ready_fd,
        idle,
        endpoint_check,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// A hidden timing flag cannot make a window shorter than 50 ms.
    #[test]
    fn hidden_timing_flags_are_clamped_to_fifty_milliseconds() {
        let opts = parse_serve(&args(&[
            "--run-dir",
            "/x",
            "--idle-grace-ms",
            "1",
            "--idle-initial-ms",
            "0",
            "--reap-after-ms",
            "49",
            "--endpoint-check-ms",
            "1",
        ]))
        .unwrap();
        let floor = Duration::from_millis(50);
        assert_eq!(opts.idle.grace, floor);
        assert_eq!(opts.idle.initial, floor);
        assert_eq!(opts.idle.reap_after, floor);
        assert_eq!(opts.endpoint_check, floor);
        let slow = parse_serve(&args(&["--run-dir", "/x", "--endpoint-check-ms", "5000"])).unwrap();
        assert_eq!(slow.endpoint_check, Duration::from_secs(5));
    }
}
