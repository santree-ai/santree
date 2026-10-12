//! Who is on the other end of a local socket.
//!
//! Every agent in a santree PTY runs as the same uid as santree, so a uid check
//! alone would let one agent attach to, read, or type into another agent's
//! terminal. On macOS the server therefore also requires its peer to be
//! code-signed by the same team with the app's identifier, and the app checks
//! the server the same way, so a squatted socket gets neither keystrokes nor
//! env secrets. The check reads the peer's audit token from the socket — never
//! its pid, which a dead peer's successor could reuse.
//!
//! Without a team id (dev builds, Linux) the caller passes `None` and only the
//! uid is checked.

use std::os::fd::RawFd;
use std::sync::OnceLock;

/// This process's own code-signing identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identity {
    Signed { team: String },
    Unsigned,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Trusted,
    Refused(String),
}

/// This process's signing team, read once: a running process's signature never
/// changes. Ad-hoc and linker-signed binaries (every `cargo build`) carry no
/// team and read `Unsigned`.
pub fn own_identity() -> Identity {
    static OWN: OnceLock<Identity> = OnceLock::new();
    OWN.get_or_init(imp::own_identity).clone()
}

/// Whether the process on the other end of the connected unix socket `fd` runs
/// as this user and — when `team` is Some — is code-signed by that team with
/// `identifier`.
pub fn verify(fd: RawFd, team: Option<&str>, identifier: &str) -> Verdict {
    let peer = match peer_uid(fd) {
        Ok(uid) => uid,
        Err(e) => return Verdict::Refused(format!("uid of peer unreadable: {e}")),
    };
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    if peer != me {
        return Verdict::Refused(format!("uid {peer} is not this user's ({me})"));
    }
    let Some(team) = team else {
        return Verdict::Trusted;
    };
    // Both strings are spliced into a requirement-language expression; anything
    // beyond this alphabet could close the quotes and rewrite the requirement.
    for (what, value) in [("team id", team), ("identifier", identifier)] {
        if !is_plain(value) {
            return Verdict::Refused(format!("{what} {value:?} is not [A-Za-z0-9.-]+"));
        }
    }
    imp::check_signature(fd, team, identifier)
}

fn is_plain(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn peer_uid(fd: RawFd) -> std::io::Result<libc::uid_t> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: both out-pointers are valid, writable locals; an invalid fd is
    // reported through the return value, not UB.
    let rc = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(uid)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(fd: RawFd) -> std::io::Result<libc::uid_t> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred` is a writable ucred and `len` holds its exact size, which
    // is what SO_PEERCRED writes; an invalid fd is reported through the return
    // value.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if len as usize != std::mem::size_of::<libc::ucred>() {
        return Err(std::io::Error::other("short SO_PEERCRED"));
    }
    Ok(cred.uid)
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{Identity, Verdict};
    use std::os::fd::RawFd;

    pub fn own_identity() -> Identity {
        Identity::Unsigned
    }

    pub fn check_signature(_fd: RawFd, _team: &str, _identifier: &str) -> Verdict {
        Verdict::Refused("code signatures are macOS-only".into())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Identity, Verdict};
    use std::ffi::{c_char, c_void};
    use std::os::fd::RawFd;
    use std::ptr;

    type CFTypeRef = *const c_void;
    type CFIndex = isize;
    type CFTypeID = usize;
    type Boolean = u8;
    type OSStatus = i32;
    type SecCSFlags = u32;

    // CoreFoundation/CFString.h
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    // Security/CSCommon.h
    const K_SEC_CS_DEFAULT_FLAGS: SecCSFlags = 0;
    // Security/SecCode.h
    const K_SEC_CS_SIGNING_INFORMATION: SecCSFlags = 1 << 1;
    // sys/un.h: `SOL_LOCAL 0`, `LOCAL_PEERTOKEN 0x006`. Spelled out rather than
    // taken from libc so an older libc can't silently lack them.
    const SOL_LOCAL: libc::c_int = 0;
    const LOCAL_PEERTOKEN: libc::c_int = 0x006;
    /// mach/message.h: `audit_token_t` is `unsigned int val[8]`.
    type AuditToken = [u32; 8];

    /// Only ever used behind a pointer.
    #[repr(C)]
    struct CFDictionaryCallBacks {
        _opaque: [u8; 0],
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeDictionaryKeyCallBacks: CFDictionaryCallBacks;
        static kCFTypeDictionaryValueCallBacks: CFDictionaryCallBacks;
        fn CFRelease(cf: CFTypeRef);
        fn CFGetTypeID(cf: CFTypeRef) -> CFTypeID;
        fn CFStringGetTypeID() -> CFTypeID;
        fn CFDataCreate(allocator: CFTypeRef, bytes: *const u8, length: CFIndex) -> CFTypeRef;
        fn CFDictionaryCreate(
            allocator: CFTypeRef,
            keys: *const CFTypeRef,
            values: *const CFTypeRef,
            count: CFIndex,
            key_callbacks: *const CFDictionaryCallBacks,
            value_callbacks: *const CFDictionaryCallBacks,
        ) -> CFTypeRef;
        fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFStringCreateWithBytes(
            allocator: CFTypeRef,
            bytes: *const u8,
            length: CFIndex,
            encoding: u32,
            is_external_representation: Boolean,
        ) -> CFTypeRef;
        fn CFStringGetLength(s: CFTypeRef) -> CFIndex;
        fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
        fn CFStringGetCString(
            s: CFTypeRef,
            buffer: *mut c_char,
            size: CFIndex,
            encoding: u32,
        ) -> Boolean;
    }

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        static kSecGuestAttributeAudit: CFTypeRef;
        static kSecCodeInfoTeamIdentifier: CFTypeRef;
        fn SecCodeCopySelf(flags: SecCSFlags, code: *mut CFTypeRef) -> OSStatus;
        fn SecCodeCopySigningInformation(
            code: CFTypeRef,
            flags: SecCSFlags,
            information: *mut CFTypeRef,
        ) -> OSStatus;
        fn SecCodeCopyGuestWithAttributes(
            host: CFTypeRef,
            attributes: CFTypeRef,
            flags: SecCSFlags,
            guest: *mut CFTypeRef,
        ) -> OSStatus;
        fn SecRequirementCreateWithString(
            text: CFTypeRef,
            flags: SecCSFlags,
            requirement: *mut CFTypeRef,
        ) -> OSStatus;
        fn SecCodeCheckValidity(
            code: CFTypeRef,
            flags: SecCSFlags,
            requirement: CFTypeRef,
        ) -> OSStatus;
        fn SecCopyErrorMessageString(status: OSStatus, reserved: *mut c_void) -> CFTypeRef;
    }

    /// One owned (+1) CF reference, released on drop — so every early return
    /// releases what was created before it.
    struct Owned(CFTypeRef);

    impl Owned {
        fn new(r: CFTypeRef) -> Option<Owned> {
            // Not `then_some(Owned(r))`: that builds the wrapper eagerly and
            // drops it — CFRelease(NULL), a crash — when `r` is null.
            if r.is_null() {
                None
            } else {
                Some(Owned(r))
            }
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: `self.0` is non-null and this wrapper holds exactly one
            // retain on it (it only wraps Create/Copy results), released once.
            unsafe { CFRelease(self.0) }
        }
    }

    /// Runs a Copy/Create-rule call that writes its result through an
    /// out-pointer, taking ownership of whatever it wrote even on failure.
    fn copy_out(
        what: &str,
        call: impl FnOnce(*mut CFTypeRef) -> OSStatus,
    ) -> Result<Owned, String> {
        let mut out: CFTypeRef = ptr::null();
        let status = call(&mut out);
        let owned = Owned::new(out);
        match (status, owned) {
            (0, Some(owned)) => Ok(owned),
            (0, None) => Err(format!("{what} returned nothing")),
            (status, _) => Err(format!("{what}: {}", describe(status))),
        }
    }

    fn describe(status: OSStatus) -> String {
        // SAFETY: SecCopyErrorMessageString accepts any status; `reserved`
        // must be NULL. Its result follows the Copy rule and is owned here.
        let msg = Owned::new(unsafe { SecCopyErrorMessageString(status, ptr::null_mut()) })
            .and_then(|s| string_from(s.0));
        match msg {
            Some(msg) => format!("OSStatus {status} ({msg})"),
            None => format!("OSStatus {status}"),
        }
    }

    fn cf_string(s: &str) -> Option<Owned> {
        // SAFETY: `s` is valid UTF-8 for `s.len()` bytes and outlives the call;
        // the bytes are copied, and the result follows the Create rule.
        Owned::new(unsafe {
            CFStringCreateWithBytes(
                ptr::null(),
                s.as_ptr(),
                s.len() as CFIndex,
                K_CF_STRING_ENCODING_UTF8,
                0,
            )
        })
    }

    /// A borrowed CF object as a Rust string, if it is a CFString.
    fn string_from(cf: CFTypeRef) -> Option<String> {
        // SAFETY: `cf` is a live CF object the caller holds a reference to;
        // CFGetTypeID accepts any CF object.
        if cf.is_null() || unsafe { CFGetTypeID(cf) != CFStringGetTypeID() } {
            return None;
        }
        // SAFETY: `cf` is a CFString (checked above); these only read it.
        let max = unsafe {
            CFStringGetMaximumSizeForEncoding(CFStringGetLength(cf), K_CF_STRING_ENCODING_UTF8)
        };
        let mut buf = vec![0u8; usize::try_from(max).ok()? + 1];
        // SAFETY: `buf` is writable for `buf.len()` bytes, the size passed in,
        // which leaves room for the NUL CFStringGetCString writes.
        let ok = unsafe {
            CFStringGetCString(
                cf,
                buf.as_mut_ptr().cast(),
                buf.len() as CFIndex,
                K_CF_STRING_ENCODING_UTF8,
            )
        };
        if ok == 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0)?;
        buf.truncate(end);
        String::from_utf8(buf).ok()
    }

    pub fn own_identity() -> Identity {
        match own_team() {
            Ok(Some(team)) => Identity::Signed { team },
            Ok(None) => Identity::Unsigned,
            Err(e) => {
                log::warn!("reading this process's code signature failed: {e}");
                Identity::Unsigned
            }
        }
    }

    fn own_team() -> Result<Option<String>, String> {
        // SAFETY: the out-pointer is a valid local; copy_out owns the result.
        let code = copy_out("SecCodeCopySelf", |out| unsafe {
            SecCodeCopySelf(K_SEC_CS_DEFAULT_FLAGS, out)
        })?;
        // SAFETY: `code` is a live SecCode (a SecCode is accepted wherever a
        // SecStaticCode is); the out-pointer is a valid local.
        let info = copy_out("SecCodeCopySigningInformation", |out| unsafe {
            SecCodeCopySigningInformation(code.0, K_SEC_CS_SIGNING_INFORMATION, out)
        })?;
        // SAFETY: `info` is a live CFDictionary and the key a framework
        // constant. The value follows the Get rule — borrowed from `info`,
        // which outlives its use in string_from.
        let team = unsafe { CFDictionaryGetValue(info.0, kSecCodeInfoTeamIdentifier) };
        Ok(string_from(team).filter(|t| !t.is_empty()))
    }

    /// Validity is checked against the executable on disk as well as the
    /// running process, so a peer whose executable was replaced since it
    /// launched (an app the updater swapped but that hasn't relaunched yet) is
    /// refused with errSecCSStaticCodeChanged (-67034).
    pub fn check_signature(fd: RawFd, team: &str, identifier: &str) -> Verdict {
        let requirement = format!(
            "anchor apple generic and certificate leaf[subject.OU] = \"{team}\" \
             and identifier \"{identifier}\""
        );
        match check_requirement(fd, &requirement) {
            Ok(()) => Verdict::Trusted,
            Err(e) => Verdict::Refused(format!(
                "peer is not {identifier} signed by team {team}: {e}"
            )),
        }
    }

    /// Checks the code behind `fd`'s peer against a requirement-language
    /// string. Callers must not splice untrusted text into `requirement`.
    pub(crate) fn check_requirement(fd: RawFd, requirement: &str) -> Result<(), String> {
        let code = peer_code(fd)?;
        let text = cf_string(requirement).ok_or("CFStringCreateWithBytes failed")?;
        // SAFETY: `text` is a live CFString; the out-pointer is a valid local.
        let req = copy_out("SecRequirementCreateWithString", |out| unsafe {
            SecRequirementCreateWithString(text.0, K_SEC_CS_DEFAULT_FLAGS, out)
        })?;
        // SAFETY: `code` and `req` are live SecCode / SecRequirement objects.
        match unsafe { SecCodeCheckValidity(code.0, K_SEC_CS_DEFAULT_FLAGS, req.0) } {
            0 => Ok(()),
            status => Err(describe(status)),
        }
    }

    /// The audit token of `fd`'s peer.
    fn read_token(fd: RawFd) -> Result<AuditToken, String> {
        let mut token: AuditToken = [0; 8];
        let mut len = std::mem::size_of::<AuditToken>() as libc::socklen_t;
        // SAFETY: `token` is writable for `len` bytes, the size of the
        // audit_token_t LOCAL_PEERTOKEN writes; a bad fd is reported via rc.
        let rc = unsafe {
            libc::getsockopt(
                fd,
                SOL_LOCAL,
                LOCAL_PEERTOKEN,
                token.as_mut_ptr().cast(),
                &mut len,
            )
        };
        if rc != 0 {
            return Err(format!(
                "peer audit token unreadable: {}",
                std::io::Error::last_os_error()
            ));
        }
        if len as usize != std::mem::size_of::<AuditToken>() {
            return Err(format!("peer audit token is {len} bytes, not 32"));
        }
        Ok(token)
    }

    /// The SecCode of the process on the other end of `fd`, located by its
    /// audit token: unlike a pid, a token names one process lifetime, so a
    /// peer that exits can't be impersonated by whatever reuses its pid.
    fn peer_code(fd: RawFd) -> Result<Owned, String> {
        let token = read_token(fd)?;
        // SAFETY: `token` is readable for its full size; CFDataCreate copies
        // the bytes, and its result follows the Create rule.
        let data = Owned::new(unsafe {
            CFDataCreate(
                ptr::null(),
                token.as_ptr().cast(),
                std::mem::size_of::<AuditToken>() as CFIndex,
            )
        })
        .ok_or("CFDataCreate failed")?;
        // SAFETY: one key and one value, both live CF objects; the CFType
        // callbacks make the dictionary retain them, so it owns its own
        // references and `data` can be released independently.
        let attributes = Owned::new(unsafe {
            CFDictionaryCreate(
                ptr::null(),
                &kSecGuestAttributeAudit,
                &data.0,
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            )
        })
        .ok_or("CFDictionaryCreate failed")?;
        // SAFETY: a NULL host means the system's root of code hosting;
        // `attributes` is a live CFDictionary; the out-pointer is a valid local.
        copy_out("SecCodeCopyGuestWithAttributes", |out| unsafe {
            SecCodeCopyGuestWithAttributes(ptr::null(), attributes.0, K_SEC_CS_DEFAULT_FLAGS, out)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    #[test]
    fn same_process_peer_passes_the_uid_check() {
        let (a, b) = UnixStream::pair().unwrap();
        assert_eq!(verify(a.as_raw_fd(), None, "x"), Verdict::Trusted);
        assert_eq!(verify(b.as_raw_fd(), None, "x"), Verdict::Trusted);
    }

    #[test]
    fn a_non_socket_is_refused() {
        let file = std::fs::File::open("/dev/null").unwrap();
        match verify(file.as_raw_fd(), None, "x") {
            Verdict::Refused(why) => assert!(why.starts_with("uid of peer unreadable"), "{why}"),
            Verdict::Trusted => panic!("/dev/null trusted"),
        }
    }

    #[test]
    fn a_test_binary_has_no_team() {
        // cargo test binaries are linker-signed ad hoc: signed, but no team.
        assert_eq!(own_identity(), Identity::Unsigned);
    }

    #[test]
    fn requirement_injection_is_refused_before_security_runs() {
        let (a, _b) = UnixStream::pair().unwrap();
        // Were these handed to Security, a same-process peer would be checked
        // against the requirement and refused with an OSStatus instead.
        for (team, id) in [
            ("AB\" or true", "x"),
            ("ABCDE12345", "com.x\" or anchor apple or identifier \"y"),
            ("", "x"),
            ("ABCDE12345", ""),
            ("AB CD", "x"),
        ] {
            match verify(a.as_raw_fd(), Some(team), id) {
                Verdict::Refused(why) => assert!(
                    why.contains("is not [A-Za-z0-9.-]+") && !why.contains("OSStatus"),
                    "{why}"
                ),
                Verdict::Trusted => panic!("{team:?} / {id:?} trusted"),
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_team_is_refused_off_macos() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(
            verify(a.as_raw_fd(), Some("ABCDE12345"), "x"),
            Verdict::Refused("code signatures are macOS-only".into())
        );
    }

    #[cfg(target_os = "macos")]
    mod apple_peer {
        use std::os::unix::net::{UnixListener, UnixStream};
        use std::path::Path;
        use std::process::{Child, Command, Stdio};
        use std::sync::atomic::{AtomicUsize, Ordering};

        /// A connection accepted from `exe`, e.g. `nc`: an Apple platform
        /// binary, signed `anchor apple` with no team OU. Killed on drop.
        pub struct Peer {
            pub stream: UnixStream,
            child: Child,
        }

        impl Peer {
            /// Kills and reaps the peer, keeping the accepted end open.
            pub fn kill(mut self) -> UnixStream {
                let _ = self.child.kill();
                let _ = self.child.wait();
                self.stream.try_clone().unwrap()
            }
        }

        impl Drop for Peer {
            fn drop(&mut self) {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }

        pub fn nc() -> Peer {
            connect(Path::new("/usr/bin/nc"), &["-U"])
        }

        /// Runs `exe args… <path>` to connect to a fresh socket. The path is
        /// relative (to cargo's cwd for tests, the crate dir) because sun_path
        /// holds only 104 bytes and an absolute temp path can be longer.
        pub fn connect(exe: &Path, args: &[&str]) -> Peer {
            static N: AtomicUsize = AtomicUsize::new(0);
            let path = format!(
                "peer-{}-{}.sock",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            );
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path).unwrap();
            let child = Command::new(exe)
                .args(args)
                .arg(&path)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let (stream, _) = listener.accept().unwrap();
            let _ = std::fs::remove_file(&path);
            Peer { stream, child }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn audit_token_reaches_the_requirement_check() {
        use super::imp::check_requirement;
        let peer = apple_peer::nc();
        let fd = peer.stream.as_raw_fd();
        assert_eq!(check_requirement(fd, "anchor apple"), Ok(()));
        assert_eq!(check_requirement(fd, "identifier \"com.apple.nc\""), Ok(()));
        let err = check_requirement(
            fd,
            "anchor apple generic and certificate leaf[subject.OU] = \"XXXXXXXXXX\"",
        )
        .unwrap_err();
        assert!(err.contains("-67050"), "{err}"); // errSecCSReqFailed
        match verify(fd, Some("XXXXXXXXXX"), "com.apple.nc") {
            Verdict::Refused(why) => assert!(why.contains("-67050"), "{why}"),
            Verdict::Trusted => panic!("nc passed as team XXXXXXXXXX"),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_failed_copy_is_an_error_not_a_crash() {
        use super::imp::check_requirement;
        // SecRequirementCreateWithString fails and leaves its out-pointer NULL.
        let peer = apple_peer::nc();
        let err = check_requirement(peer.stream.as_raw_fd(), "not a requirement (").unwrap_err();
        assert!(
            err.starts_with("SecRequirementCreateWithString: OSStatus"),
            "{err}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_hung_up_peer_is_refused() {
        let peer = apple_peer::nc();
        let stream = peer.kill();
        // nc satisfies `anchor apple` while it runs; once it's gone there is
        // no code to check, and nothing else may answer for it.
        let err = super::imp::check_requirement(stream.as_raw_fd(), "anchor apple").unwrap_err();
        assert!(err.starts_with("peer audit token unreadable"), "{err}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_peer_is_the_connected_process_not_this_one() {
        use super::imp::check_requirement;
        // This (ad-hoc signed) test binary is not `anchor apple`; nc is. A
        // token read from the wrong end would flip both results.
        let (a, _b) = UnixStream::pair().unwrap();
        assert!(check_requirement(a.as_raw_fd(), "anchor apple").is_err());
        let peer = apple_peer::nc();
        assert_eq!(
            check_requirement(peer.stream.as_raw_fd(), "anchor apple"),
            Ok(())
        );
    }
}
