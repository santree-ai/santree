//! The TLS profile of the santree ↔ daedalus session-host link, shared by both
//! ends so they cannot drift: santree's client and the engine's session host
//! build their rustls configs here and nowhere else.
//!
//! **Keys are pinned, names and CAs are not used.** Each end holds an ed25519
//! [`Identity`] and presents a self-signed certificate made from it (cert.rs).
//! What each accepts:
//!
//! - the client ([`client_config`]) accepts the host only if the certificate
//!   carries exactly the pinned 32-byte public key (compared in constant time);
//! - the host ([`server_config`]) demands a client certificate and accepts it
//!   only if its key passes the caller's `allow` check (the enrolled devices).
//!
//! Either way the peer then proves it holds that key by signing the handshake
//! (TLS 1.3 CertificateVerify), which is checked by rustls' own
//! `verify_tls13_signature` over ring's algorithms — the pin decides *which*
//! key, the signature proves *possession*.
//!
//! The profile, both sides: TLS 1.3 only; the ED25519 signature scheme only;
//! ring's provider, passed explicitly (never the process default); no session
//! resumption, no tickets, no 0-RTT — every connection proves its key afresh;
//! a fixed SNI, [`SERVER_NAME`], that nobody validates.
//!
//! **How a refusal reaches the client** ([`Refusal::of`]): a wrong host key
//! fails the client's own handshake ([`Refusal::HostKeyMismatch`]). A client
//! key the host does not allow does NOT fail the connect: in TLS 1.3 the client
//! finishes its side before the host has judged its certificate, so the host's
//! `access_denied` alert arrives on the client's first read
//! ([`Refusal::NotEnrolled`]).

use std::fmt;
use std::io;
use std::sync::{Arc, LazyLock};

use ring::signature::{Ed25519KeyPair, KeyPair};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{
    AlertDescription, CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName,
    Error, PeerMisbehaved, ServerConfig, SignatureScheme,
};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncWrite};

mod cert;

pub use cert::public_key_of;
/// The rustls this crate builds with, so callers name the same types.
pub use rustls;
/// The tokio-rustls this crate builds with.
pub use tokio_rustls;

/// The SNI the client sends. The host serves one key and checks no name, so
/// this is a constant, not an address.
pub const SERVER_NAME: &str = "daedalus-session-host";

/// ring's provider, the only one this profile ever uses.
static PROVIDER: LazyLock<Arc<CryptoProvider>> =
    LazyLock::new(|| Arc::new(rustls::crypto::ring::default_provider()));

/// The client's stream after [`connect`].
pub type ClientStream<S> = tokio_rustls::client::TlsStream<S>;
/// The host's stream after [`accept`].
pub type ServerStream<S> = tokio_rustls::server::TlsStream<S>;
/// The host's admission check on a client's public key.
pub type Allow = Arc<dyn Fn(&[u8; 32]) -> bool + Send + Sync>;

// ── keys ──────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    ring::digest::digest(&ring::digest::SHA256, data)
        .as_ref()
        .try_into()
        .expect("SHA-256 is 32 bytes")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A public key as the link writes it (allow-lists, the pinned host key):
/// 64 lowercase hex characters.
pub fn key_hex(key: &[u8; 32]) -> String {
    hex(key)
}

/// A public key from its 64 hex characters (either case); `None` for anything
/// else.
pub fn parse_key_hex(text: &str) -> Option<[u8; 32]> {
    // Hex digits only: `from_str_radix` alone would also take a `+` sign.
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut key = [0u8; 32];
    for (byte, pair) in key.iter_mut().zip(text.as_bytes().chunks(2)) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(key)
}

/// A public key as people compare it — the daedalus agent's format: SHA-256
/// of the key, lowercase hex, four characters to a group, the sixteen groups
/// joined by `:`. For display only; the link pins the key itself.
pub fn fingerprint(key: &[u8; 32]) -> String {
    hex(&sha256(key))
        .as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).expect("hex is ASCII"))
        .collect::<Vec<_>>()
        .join(":")
}

/// A key this crate could not load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyError(String);

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not a usable ed25519 key: {}", self.0)
    }
}

impl std::error::Error for KeyError {}

/// The RFC 8410 PKCS#8 v1 prefix of an ed25519 private key: the 32-byte seed
/// follows it.
const PKCS8_V1_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// One end's ed25519 key and the certificate made from it. The key is the
/// identity; keep [`Identity::pkcs8`] secret (santree: the Keychain; the host:
/// a 0600 file).
pub struct Identity {
    pkcs8: Vec<u8>,
    public: [u8; 32],
    cert: CertificateDer<'static>,
}

impl Identity {
    /// A new random key.
    pub fn generate() -> Result<Self, KeyError> {
        let doc = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
            .map_err(|_| KeyError("the system random source failed".into()))?;
        Self::from_pkcs8(doc.as_ref())
    }

    /// A key from its PKCS#8 DER (v1 or v2, as ring reads it).
    pub fn from_pkcs8(der: &[u8]) -> Result<Self, KeyError> {
        let pair =
            Ed25519KeyPair::from_pkcs8_maybe_unchecked(der).map_err(|e| KeyError(e.to_string()))?;
        Ok(Self {
            pkcs8: der.to_vec(),
            public: pair
                .public_key()
                .as_ref()
                .try_into()
                .expect("an ed25519 public key is 32 bytes"),
            cert: cert::self_signed(&pair),
        })
    }

    /// A key from its 32-byte seed.
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let mut der = PKCS8_V1_PREFIX.to_vec();
        der.extend_from_slice(seed);
        Self::from_pkcs8(&der).expect("every 32-byte seed is an ed25519 key")
    }

    /// The private key as PKCS#8 DER, for storing it.
    pub fn pkcs8(&self) -> &[u8] {
        &self.pkcs8
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.public
    }

    /// The self-signed certificate this end presents.
    pub fn certificate(&self) -> &CertificateDer<'static> {
        &self.cert
    }

    fn chain_and_key(&self) -> (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>) {
        (
            vec![self.cert.clone()],
            PrivatePkcs8KeyDer::from(self.pkcs8.clone()).into(),
        )
    }
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("fingerprint", &fingerprint(&self.public))
            .finish_non_exhaustive()
    }
}

// ── verifiers ─────────────────────────────────────────────────────────────

/// The peer's handshake signature over `message`, checked with the key in
/// `cert` — ED25519 only.
fn handshake_signature(
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, Error> {
    if dss.scheme != SignatureScheme::ED25519 {
        return Err(PeerMisbehaved::SignedHandshakeWithUnadvertisedSigScheme.into());
    }
    rustls::crypto::verify_tls13_signature(
        message,
        cert,
        dss,
        &PROVIDER.signature_verification_algorithms,
    )
}

fn no_tls12() -> Error {
    Error::General("TLS 1.2 is not part of the session-host profile".into())
}

fn key_in(cert: &CertificateDer<'_>) -> Result<[u8; 32], Error> {
    public_key_of(cert).ok_or(Error::InvalidCertificate(CertificateError::BadEncoding))
}

/// The client's check on the host: its certificate carries the pinned key.
#[derive(Debug)]
struct PinnedHost {
    pin: [u8; 32],
}

impl ServerCertVerifier for PinnedHost {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        if bool::from(key_in(end_entity)?.ct_eq(&self.pin)) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(no_tls12())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        handshake_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}

/// The host's check on a client: a certificate is mandatory, and its key must
/// pass `allow`. A refusal is sent as `access_denied`.
struct AllowedClients {
    allow: Allow,
}

impl fmt::Debug for AllowedClients {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AllowedClients")
    }
}

impl ClientCertVerifier for AllowedClients {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        if (self.allow)(&key_in(end_entity)?) {
            Ok(ClientCertVerified::assertion())
        } else {
            Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(no_tls12())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        handshake_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}

// ── configs ───────────────────────────────────────────────────────────────

/// santree's side: present `identity`, accept only the host whose key is
/// `host_key`.
pub fn client_config(identity: &Identity, host_key: [u8; 32]) -> Arc<ClientConfig> {
    let (chain, key) = identity.chain_and_key();
    let mut config = ClientConfig::builder_with_provider(PROVIDER.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("ring's provider speaks TLS 1.3")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedHost { pin: host_key }))
        .with_client_auth_cert(chain, key)
        .expect("an Identity's key was checked when it was made");
    config.resumption = rustls::client::Resumption::disabled();
    config.enable_early_data = false;
    Arc::new(config)
}

/// The host's side: present `identity`, demand a client certificate and admit
/// only the keys `allow` accepts — checked at every handshake, so a caller
/// whose `allow` reads a live set needs no new config when the set changes.
pub fn server_config(identity: &Identity, allow: Allow) -> Arc<ServerConfig> {
    let (chain, key) = identity.chain_and_key();
    let mut config = ServerConfig::builder_with_provider(PROVIDER.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("ring's provider speaks TLS 1.3")
        .with_client_cert_verifier(Arc::new(AllowedClients { allow }))
        .with_single_cert(chain, key)
        .expect("an Identity's key was checked when it was made");
    config.send_tls13_tickets = 0;
    config.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    config.max_early_data_size = 0;
    Arc::new(config)
}

/// Run the client's handshake over `stream`. A caller bounds it with its own
/// timeout. The host has not necessarily accepted this client when it returns
/// (module doc): read [`Refusal::of`] the first read's error.
pub async fn connect<S>(config: Arc<ClientConfig>, stream: S) -> io::Result<ClientStream<S>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let name = ServerName::try_from(SERVER_NAME).expect("a valid DNS name");
    tokio_rustls::TlsConnector::from(config)
        .connect(name, stream)
        .await
}

/// Run the host's handshake over `stream`. A caller bounds it with its own
/// timeout.
pub async fn accept<S>(config: Arc<ServerConfig>, stream: S) -> io::Result<ServerStream<S>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    tokio_rustls::TlsAcceptor::from(config).accept(stream).await
}

/// The key the peer's certificate carries, once the handshake has proved it
/// (`stream.get_ref().1`).
pub fn peer_key(state: &rustls::CommonState) -> Option<[u8; 32]> {
    public_key_of(state.peer_certificates()?.first()?)
}

// ── refusals ──────────────────────────────────────────────────────────────

/// Why the link refused this client, as the client sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The host presented another key than the pinned one. From [`connect`].
    HostKeyMismatch,
    /// The host does not admit this client's key: never enrolled, or revoked.
    /// From the first read after [`connect`] (module doc).
    NotEnrolled,
}

impl Refusal {
    /// The refusal `e` carries, if it is one; `None` for every other failure
    /// (network, timeout, a peer that does not speak the profile).
    pub fn of(e: &io::Error) -> Option<Refusal> {
        match e.get_ref()?.downcast_ref::<Error>()? {
            Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure) => {
                Some(Refusal::HostKeyMismatch)
            }
            Error::AlertReceived(AlertDescription::AccessDenied) => Some(Refusal::NotEnrolled),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8032 §7.1, TEST 1: the seed, and the public key it must give.
    const RFC8032_SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    const RFC8032_PUBLIC: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

    #[test]
    fn a_seed_gives_the_rfc_8032_key() {
        let id = Identity::from_seed(&parse_key_hex(RFC8032_SEED).unwrap());
        assert_eq!(key_hex(&id.public_key()), RFC8032_PUBLIC);
        // The PKCS#8 it keeps loads back as the same key.
        let again = Identity::from_pkcs8(id.pkcs8()).unwrap();
        assert_eq!(again.public_key(), id.public_key());
    }

    /// Golden vectors, in the daedalus agent's format (agent/src/identity.rs
    /// `fingerprint`: SHA-256, lowercase hex, groups of four joined by `:`).
    #[test]
    fn fingerprints_match_the_agents_format() {
        assert_eq!(
            fingerprint(&parse_key_hex(RFC8032_PUBLIC).unwrap()),
            "21fe:31df:a154:a261:626b:f854:046f:d227:1b7b:ed4b:6abe:45aa:5887:7ef4:7f97:21b9"
        );
        assert_eq!(
            fingerprint(&[0; 32]),
            "6668:7aad:f862:bd77:6c8f:c18b:8e9f:8e20:0897:1485:6ee2:33b3:902a:591d:0d5f:2925"
        );
    }

    #[test]
    fn generated_keys_differ_and_reload() {
        let (a, b) = (Identity::generate().unwrap(), Identity::generate().unwrap());
        assert_ne!(a.public_key(), b.public_key());
        let again = Identity::from_pkcs8(a.pkcs8()).unwrap();
        assert_eq!(again.public_key(), a.public_key());
        assert!(Identity::from_pkcs8(b"not a key").is_err());
    }

    #[test]
    fn key_hex_round_trips_and_rejects_the_rest() {
        let key: [u8; 32] = std::array::from_fn(|i| i as u8 * 7);
        let text = key_hex(&key);
        assert_eq!(text.len(), 64);
        assert_eq!(parse_key_hex(&text), Some(key));
        assert_eq!(parse_key_hex(&text.to_uppercase()), Some(key));
        for bad in [
            "",
            "00",
            &"g".repeat(64),
            &format!("{text}00"),
            &"é".repeat(32),
            &"+0".repeat(32),
        ] {
            assert_eq!(parse_key_hex(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_debug_form_shows_no_secret() {
        let id = Identity::from_seed(&[9; 32]);
        let shown = format!("{id:?}");
        assert!(shown.contains(&fingerprint(&id.public_key())));
        assert!(!shown.contains(&hex(id.pkcs8())));
    }
}
