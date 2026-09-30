//! The certificate each end presents, and the one thing ever read back from a
//! peer's: its ed25519 public key.
//!
//! TLS wants a certificate; the link has no CA and trusts keys, not names. So
//! each end makes a minimal self-signed X.509 v3 certificate from its identity
//! key — subject and issuer `CN=santree-remote <16 hex of the key's SHA-256>`,
//! valid from 2026 to the RFC 5280 "no expiry" date, no extensions — written by
//! the small DER writer below and signed with the same key. It is made when
//! the identity is loaded and never stored: the key is the identity, the
//! certificate its envelope.
//!
//! Reading a peer's goes through webpki's parser (`ParsedCertificate`) and
//! takes its SubjectPublicKeyInfo only if it is an ed25519 key. The
//! certificate's own signature is not checked and need not be: the peer proves
//! it holds the key by signing the handshake with it (TLS 1.3's
//! CertificateVerify, which the verifiers in lib.rs check), and whether the key
//! is the right one is the pin's business.

use ring::signature::{Ed25519KeyPair, KeyPair};
use rustls::pki_types::CertificateDer;

use crate::{hex, sha256};

/// The fixed SubjectPublicKeyInfo prefix of an ed25519 public key (RFC 8410
/// §4): the 32-byte key follows it.
const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];
/// `1.3.101.112`, id-Ed25519, as an AlgorithmIdentifier without parameters.
const ED25519_ALG: [u8; 7] = [0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70];
/// `2.5.4.3`, commonName.
const CN_OID: [u8; 5] = [0x06, 0x03, 0x55, 0x04, 0x03];

/// A DER element: tag, length, contents.
fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let n = content.len();
    if n < 0x80 {
        out.push(n as u8);
    } else {
        let bytes = n.to_be_bytes();
        let skip = bytes.iter().take_while(|b| **b == 0).count();
        out.push(0x80 | (bytes.len() - skip) as u8);
        out.extend_from_slice(&bytes[skip..]);
    }
    out.extend_from_slice(content);
    out
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

/// A self-signed certificate for `key`, as DER. Deterministic: ed25519
/// signatures are, and nothing else varies.
pub(crate) fn self_signed(key: &Ed25519KeyPair) -> CertificateDer<'static> {
    let public = key.public_key().as_ref();
    let digest = sha256(public);
    // A positive serial from the key: eight bytes, top bit clear, never zero.
    let mut serial = digest[..8].to_vec();
    serial[0] = (serial[0] & 0x7f) | 0x01;
    let name = {
        let cn = format!("santree-remote {}", hex(&digest[..8]));
        let attr = seq(&[&CN_OID, &tlv(0x0c, cn.as_bytes())]);
        seq(&[&tlv(0x31, &attr)])
    };
    let validity = seq(&[&tlv(0x17, b"260101000000Z"), &tlv(0x18, b"99991231235959Z")]);
    let mut spki = SPKI_PREFIX.to_vec();
    spki.extend_from_slice(public);
    let tbs = seq(&[
        // [0] EXPLICIT version: v3.
        &tlv(0xa0, &tlv(0x02, &[0x02])),
        &tlv(0x02, &serial),
        &ED25519_ALG,
        &name,
        &validity,
        &name,
        &spki,
    ]);
    let mut bits = vec![0u8];
    bits.extend_from_slice(key.sign(&tbs).as_ref());
    CertificateDer::from(seq(&[&tbs, &ED25519_ALG, &tlv(0x03, &bits)]))
}

/// The ed25519 public key `cert` carries; `None` for anything that is not a
/// certificate, or whose key is of another kind.
pub fn public_key_of(cert: &CertificateDer<'_>) -> Option<[u8; 32]> {
    let parsed = rustls::server::ParsedCertificate::try_from(cert).ok()?;
    let spki = parsed.subject_public_key_info();
    spki.as_ref()
        .strip_prefix(&SPKI_PREFIX[..])?
        .try_into()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Identity;

    #[test]
    fn the_certificate_parses_and_carries_the_key() {
        let id = Identity::from_seed(&[5; 32]);
        let cert = id.certificate();
        assert_eq!(public_key_of(cert), Some(id.public_key()));
        // Deterministic: the same key makes the same bytes.
        assert_eq!(Identity::from_seed(&[5; 32]).certificate(), cert);
        assert_eq!(public_key_of(&CertificateDer::from(vec![0x30, 0x00])), None);
    }

    #[test]
    fn a_key_of_another_kind_is_not_read() {
        // The same certificate with its key's OID turned into Ed448's
        // (1.3.101.113): still a certificate, no longer an ed25519 key.
        let cert = Identity::from_seed(&[5; 32]).certificate().to_vec();
        let at = cert
            .windows(SPKI_PREFIX.len())
            .position(|w| w == SPKI_PREFIX)
            .expect("the SPKI is in the certificate");
        let mut other = cert.clone();
        other[at + 8] = 0x71;
        assert_eq!(public_key_of(&CertificateDer::from(other)), None);
    }

    #[test]
    fn long_lengths_use_the_long_form() {
        assert_eq!(tlv(0x04, &[1; 3]), [0x04, 3, 1, 1, 1]);
        let long = tlv(0x04, &[0; 200]);
        assert_eq!(&long[..3], &[0x04, 0x81, 200]);
        let longer = tlv(0x04, &[0; 300]);
        assert_eq!(&longer[..4], &[0x04, 0x82, 0x01, 0x2c]);
    }
}
