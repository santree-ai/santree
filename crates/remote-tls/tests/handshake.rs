//! Handshakes over an in-memory duplex: what the profile admits, what it
//! refuses, and how each refusal reaches the client.

use std::io;
use std::sync::{Arc, Mutex};

use santree_remote_tls::rustls::client::{ResolvesClientCert, Resumption};
use santree_remote_tls::rustls::crypto::ring::{default_provider, sign::any_eddsa_type, Ticketer};
use santree_remote_tls::rustls::pki_types::PrivatePkcs8KeyDer;
use santree_remote_tls::rustls::server::ServerSessionMemoryCache;
use santree_remote_tls::rustls::sign::{CertifiedKey, SingleCertAndKey};
use santree_remote_tls::rustls::{
    self, AlertDescription, ClientConfig, HandshakeKind, ProtocolVersion, RootCertStore,
    ServerConfig, SignatureScheme,
};
use santree_remote_tls::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

fn id(n: u8) -> Identity {
    Identity::from_seed(&[n; 32])
}

fn allow_only(keys: &[[u8; 32]]) -> Allow {
    let keys = keys.to_vec();
    Arc::new(move |key| keys.contains(key))
}

type Pair = (
    io::Result<ClientStream<DuplexStream>>,
    io::Result<ServerStream<DuplexStream>>,
);

async fn pair(client: Arc<ClientConfig>, server: Arc<ServerConfig>) -> Pair {
    let (a, b) = tokio::io::duplex(64 * 1024);
    tokio::join!(connect(client, a), accept(server, b))
}

fn rustls_error(e: &io::Error) -> &rustls::Error {
    e.get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
        .unwrap_or_else(|| panic!("not a TLS error: {e}"))
}

/// The client's first read, which must fail.
async fn first_read_error(client: &mut ClientStream<DuplexStream>) -> io::Error {
    let mut buf = [0u8; 16];
    client
        .read(&mut buf)
        .await
        .expect_err("the host refused this client")
}

/// A ping from the client, a pong from the host.
async fn ping_pong(c: &mut ClientStream<DuplexStream>, s: &mut ServerStream<DuplexStream>) {
    c.write_all(b"ping\n").await.unwrap();
    let mut got = [0u8; 5];
    s.read_exact(&mut got).await.unwrap();
    assert_eq!(&got, b"ping\n");
    s.write_all(b"pong\n").await.unwrap();
    c.read_exact(&mut got).await.unwrap();
    assert_eq!(&got, b"pong\n");
}

#[tokio::test]
async fn a_pinned_host_and_an_allowed_client_talk_both_ways() {
    let (device, host) = (id(1), id(2));
    let (c, s) = pair(
        client_config(&device, host.public_key()),
        server_config(&host, allow_only(&[device.public_key()])),
    )
    .await;
    let (mut c, mut s) = (c.unwrap(), s.unwrap());
    // Each end knows the key the other's handshake proved.
    assert_eq!(peer_key(c.get_ref().1), Some(host.public_key()));
    assert_eq!(peer_key(s.get_ref().1), Some(device.public_key()));
    let states: [&rustls::CommonState; 2] = [c.get_ref().1, s.get_ref().1];
    for state in states {
        assert_eq!(state.protocol_version(), Some(ProtocolVersion::TLSv1_3));
        assert_eq!(state.handshake_kind(), Some(HandshakeKind::Full));
    }
    assert_eq!(s.get_ref().1.server_name(), Some(SERVER_NAME));
    ping_pong(&mut c, &mut s).await;
    // A write far past one TLS record arrives whole.
    let big = vec![7u8; 300_000];
    let reader = tokio::spawn(async move {
        let mut got = vec![0u8; 300_000];
        c.read_exact(&mut got).await.unwrap();
        got
    });
    s.write_all(&big).await.unwrap();
    assert_eq!(reader.await.unwrap(), big);
}

#[tokio::test]
async fn a_host_with_another_key_fails_the_connect_as_a_mismatch() {
    let (device, host, other) = (id(1), id(2), id(3));
    let (c, s) = pair(
        client_config(&device, other.public_key()),
        server_config(&host, allow_only(&[device.public_key()])),
    )
    .await;
    let e = c.expect_err("the pin names another key");
    assert_eq!(Refusal::of(&e), Some(Refusal::HostKeyMismatch));
    assert!(s.is_err());
}

#[tokio::test]
async fn an_unlisted_client_connects_then_its_first_read_says_not_enrolled() {
    let (device, host, enrolled) = (id(1), id(2), id(3));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = asked.clone();
    let allow: Allow = Arc::new(move |key| {
        seen.lock().unwrap().push(*key);
        *key == enrolled.public_key()
    });
    let (c, s) = pair(
        client_config(&device, host.public_key()),
        server_config(&host, allow),
    )
    .await;
    // TLS 1.3: the client's side of the handshake is done before the host
    // has judged its certificate.
    let mut c = c.expect("the connect itself succeeds");
    assert!(s.is_err());
    let e = first_read_error(&mut c).await;
    assert_eq!(Refusal::of(&e), Some(Refusal::NotEnrolled));
    assert_eq!(*asked.lock().unwrap(), vec![device.public_key()]);
}

#[derive(Debug)]
struct NoCertificate;

impl ResolvesClientCert for NoCertificate {
    fn resolve(&self, _: &[&[u8]], _: &[SignatureScheme]) -> Option<Arc<CertifiedKey>> {
        None
    }

    fn has_certs(&self) -> bool {
        false
    }
}

#[tokio::test]
async fn a_client_without_a_certificate_is_refused() {
    let (device, host) = (id(1), id(2));
    let mut client = (*client_config(&device, host.public_key())).clone();
    client.client_auth_cert_resolver = Arc::new(NoCertificate);
    let allow: Allow = Arc::new(|_| panic!("no key to ask about"));
    let (c, s) = pair(Arc::new(client), server_config(&host, allow)).await;
    let mut c = c.unwrap();
    assert!(s.is_err());
    let e = first_read_error(&mut c).await;
    assert_eq!(
        rustls_error(&e),
        &rustls::Error::AlertReceived(AlertDescription::CertificateRequired)
    );
    assert_eq!(Refusal::of(&e), None);
}

fn signing_key_of(identity: &Identity) -> Arc<dyn rustls::sign::SigningKey> {
    any_eddsa_type(&PrivatePkcs8KeyDer::from(identity.pkcs8().to_vec())).unwrap()
}

/// `shown`'s certificate, signed for by `holder`'s key: an end that presents
/// a key it does not hold.
fn impostor(shown: &Identity, holder: &Identity) -> Arc<SingleCertAndKey> {
    Arc::new(SingleCertAndKey::from(CertifiedKey::new(
        vec![shown.certificate().clone()],
        signing_key_of(holder),
    )))
}

#[tokio::test]
async fn a_host_presenting_the_pinned_key_without_holding_it_is_refused() {
    let (device, host, thief) = (id(1), id(2), id(3));
    let mut server = (*server_config(&thief, allow_only(&[device.public_key()]))).clone();
    server.cert_resolver = impostor(&host, &thief);
    let (c, s) = pair(client_config(&device, host.public_key()), Arc::new(server)).await;
    let e = c.expect_err("the handshake signature is not the pinned key's");
    // The pin matched; the signature did not. Not a mismatch: an attack.
    assert_eq!(Refusal::of(&e), None);
    assert!(s.is_err());
}

#[tokio::test]
async fn a_client_presenting_an_enrolled_key_without_holding_it_is_refused() {
    let (enrolled, host, thief) = (id(1), id(2), id(3));
    let mut client = (*client_config(&thief, host.public_key())).clone();
    client.client_auth_cert_resolver = impostor(&enrolled, &thief);
    let (c, s) = pair(
        Arc::new(client),
        server_config(&host, allow_only(&[enrolled.public_key()])),
    )
    .await;
    let mut c = c.unwrap();
    assert!(s.is_err());
    let e = first_read_error(&mut c).await;
    assert_eq!(Refusal::of(&e), None);
}

#[tokio::test]
async fn a_tls12_only_host_is_refused() {
    let (device, host) = (id(1), id(2));
    let server = ServerConfig::builder_with_provider(Arc::new(default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS12])
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![host.certificate().clone()],
            PrivatePkcs8KeyDer::from(host.pkcs8().to_vec()).into(),
        )
        .unwrap();
    let (c, s) = pair(client_config(&device, host.public_key()), Arc::new(server)).await;
    assert_eq!(Refusal::of(&c.expect_err("no common version")), None);
    assert!(s.is_err());
}

#[tokio::test]
async fn a_tls12_only_client_is_refused() {
    let (device, host) = (id(1), id(2));
    let client = ClientConfig::builder_with_provider(Arc::new(default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS12])
        .unwrap()
        .with_root_certificates(RootCertStore::empty())
        .with_no_client_auth();
    let (c, s) = pair(
        Arc::new(client),
        server_config(&host, allow_only(&[device.public_key()])),
    )
    .await;
    assert!(c.is_err());
    assert!(s.is_err());
}

/// Two connections with the same configs; of the second: its handshake kind
/// as the client and the host saw it, and the tickets the client was sent.
async fn second_handshake(
    client: Arc<ClientConfig>,
    server: Arc<ServerConfig>,
) -> (HandshakeKind, HandshakeKind, u32) {
    let mut seen = None;
    for _ in 0..2 {
        let (c, s) = pair(client.clone(), server.clone()).await;
        let (mut c, mut s) = (c.unwrap(), s.unwrap());
        // Any ticket the host sends arrives ahead of the pong.
        ping_pong(&mut c, &mut s).await;
        seen = Some((
            c.get_ref().1.handshake_kind().unwrap(),
            s.get_ref().1.handshake_kind().unwrap(),
            c.get_ref().1.tls13_tickets_received(),
        ));
    }
    seen.unwrap()
}

#[tokio::test]
async fn no_session_is_ever_resumed() {
    use HandshakeKind::{Full, Resumed};
    let (device, host) = (id(1), id(2));
    let ours_client = client_config(&device, host.public_key());
    let ours_server = server_config(&host, allow_only(&[device.public_key()]));
    assert!(!ours_client.enable_early_data);
    assert_eq!(ours_server.send_tls13_tickets, 0);
    assert_eq!(ours_server.max_early_data_size, 0);

    // A client and a host that DO resume, so the checks below can see it.
    // (A memory cache under 8 entries holds no server at all.)
    let mut eager_client = (*ours_client).clone();
    eager_client.resumption = Resumption::in_memory_sessions(64);
    let eager_client = Arc::new(eager_client);
    let mut eager_server = (*ours_server).clone();
    eager_server.send_tls13_tickets = 2;
    eager_server.ticketer = Ticketer::new().unwrap();
    eager_server.session_storage = ServerSessionMemoryCache::new(64);
    let eager_server = Arc::new(eager_server);
    assert_eq!(
        second_handshake(eager_client.clone(), eager_server.clone()).await,
        (Resumed, Resumed, 2)
    );

    // Our client keeps no ticket it is sent; our host sends none.
    assert_eq!(
        second_handshake(ours_client.clone(), eager_server).await,
        (Full, Full, 2)
    );
    assert_eq!(
        second_handshake(eager_client, ours_server.clone()).await,
        (Full, Full, 0)
    );
    assert_eq!(
        second_handshake(ours_client, ours_server).await,
        (Full, Full, 0)
    );
}
