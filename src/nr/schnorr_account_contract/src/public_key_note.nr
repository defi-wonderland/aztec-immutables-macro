use aztec::{macros::notes::note, protocol::traits::Packable};

/// Stores a signing public key composed of two field elements (x, y coordinates).
///
/// This note is stored in SinglePrivateImmutable storage and holds the
/// Schnorr signing public key for the account contract.
#[derive(Eq, Packable)]
#[note]
pub struct PublicKeyNote {
    pub x: Field,
    pub y: Field,
}
