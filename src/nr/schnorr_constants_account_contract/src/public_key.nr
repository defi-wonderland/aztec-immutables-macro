use aztec::protocol_types::traits::{Deserialize, Serialize};

/// A public key composed of two field elements (x, y coordinates on the Grumpkin curve).
#[derive(Eq, Serialize, Deserialize)]
pub struct PublicKey {
    pub x: Field,
    pub y: Field,
}
