//! # Schnorr Account Contract (Standard)
//!
//! An account contract using Schnorr signatures for authentication with the
//! **standard initializer** pattern. The signing public key is stored in
//! private immutable storage via SinglePrivateImmutable.
//!
//! ## How It Works
//!
//! 1. **Deployment**: Contract is deployed with an initializer that receives the signing key
//! 2. **Storage**: The key is stored as a PublicKeyNote in SinglePrivateImmutable storage
//! 3. **Authentication**: Each auth call reads the key from private storage
//!
//! ## Comparison with SchnorrImmutablesAccount
//!
//! | Feature | This Contract | SchnorrImmutablesAccount |
//! |---------|---------------|------------------------|
//! | Storage | SinglePrivateImmutable | Capsule storage |
//! | Initializer | Required (constructor) | Not required |
//! | Deployment | Needs initializer tx + note delivery | Direct deployment |
//! | Key binding | Stored in private state tree | Committed in contract address |

mod public_key_note;

use aztec::macros::aztec;

#[aztec]
pub contract SchnorrAccount {
    use aztec::{
        authwit::{
            account::AccountActions,
            auth::{compute_authwit_message_hash, compute_authwit_nullifier},
            entrypoint::app::AppPayload,
        },
        context::PrivateContext,
        hash::compute_siloed_nullifier,
        macros::{
            functions::{allow_phase_change, external, initializer, noinitcheck, view},
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        oracle::{
            auth_witness::get_auth_witness,
            get_nullifier_membership_witness::get_low_nullifier_membership_witness,
        },
        protocol::address::AztecAddress,
        state_vars::SinglePrivateImmutable,
    };

    use crate::public_key_note::PublicKeyNote;

    #[storage]
    struct Storage<Context> {
        /// The signing public key stored as a private immutable note.
        signing_public_key: SinglePrivateImmutable<PublicKeyNote, Context>,
    }

    /// Constructor - initializes the account with a signing public key.
    ///
    /// The signing key is stored in SinglePrivateImmutable storage and
    /// delivered to the account owner via constrained onchain message.
    #[external("private")]
    #[initializer]
    fn constructor(signing_pub_key_x: Field, signing_pub_key_y: Field) {
        let pub_key_note = PublicKeyNote { x: signing_pub_key_x, y: signing_pub_key_y };

        // Store and deliver the signing public key note
        self.storage.signing_public_key.initialize(pub_key_note).deliver(
            MessageDelivery::onchain_constrained().with_sender(self.address),
        );
    }

    /// Account entrypoint - executes authenticated actions.
    ///
    /// @dev If you globally change the entrypoint signature, update account_entrypoint.ts
    #[external("private")]
    #[noinitcheck]
    #[allow_phase_change]
    fn entrypoint(app_payload: AppPayload, fee_payment_method: u8, cancellable: bool) {
        let actions = AccountActions::init(self.context, is_valid_impl);
        actions.entrypoint(app_payload, fee_payment_method, cancellable);
    }

    /// Verifies a private authorization witness.
    #[external("private")]
    #[noinitcheck]
    #[view]
    fn verify_private_authwit(inner_hash: Field) -> Field {
        let actions = AccountActions::init(self.context, is_valid_impl);
        actions.verify_private_authwit(inner_hash)
    }

    /// Core signature verification logic.
    ///
    /// Loads the signing public key from private storage and verifies
    /// the Schnorr signature against the outer_hash.
    #[contract_library_method]
    fn is_valid_impl(context: &mut PrivateContext, outer_hash: Field) -> bool {
        // Load public key from private storage
        let storage = Storage::init(context);
        let public_key = storage.signing_public_key.get_note();

        // Load auth witness (signature)
        // Safety: The witness is only used as a "magical value" that makes the signature verification pass.
        let limbs: [Field; 4] = unsafe { get_auth_witness(outer_hash) };
        let signature = (
            std::embedded_curve_ops::EmbeddedCurveScalar::new(limbs[0], limbs[1]),
            std::embedded_curve_ops::EmbeddedCurveScalar::new(limbs[2], limbs[3]),
        );

        let pub_key =
            std::embedded_curve_ops::EmbeddedCurvePoint { x: public_key.x, y: public_key.y };

        // Verify Schnorr signature of the payload
        schnorr::verify_signature(pub_key, signature, outer_hash)
    }

    /// Helper to check validity of private authwitnesses (unconstrained).
    ///
    /// Used by wallets to check if an authwit is valid before sending.
    #[external("utility")]
    unconstrained fn lookup_validity(consumer: AztecAddress, inner_hash: Field) -> bool {
        let public_key = self.storage.signing_public_key.view_note();

        let message_hash = compute_authwit_message_hash(
            consumer,
            self.context.chain_id(),
            self.context.version(),
            inner_hash,
        );

        let limbs: [Field; 4] = get_auth_witness(message_hash);
        let signature = (
            std::embedded_curve_ops::EmbeddedCurveScalar::new(limbs[0], limbs[1]),
            std::embedded_curve_ops::EmbeddedCurveScalar::new(limbs[2], limbs[3]),
        );

        let pub_key =
            std::embedded_curve_ops::EmbeddedCurvePoint { x: public_key.x, y: public_key.y };

        let valid_in_private = schnorr::verify_signature(pub_key, signature, message_hash);

        // Check if the authwit has already been consumed
        let nullifier = compute_authwit_nullifier(self.address, inner_hash);
        let siloed_nullifier = compute_siloed_nullifier(consumer, nullifier);
        let (leaf_preimage, _witness) =
            get_low_nullifier_membership_witness(self.context.block_header(), siloed_nullifier);
        let is_spent = leaf_preimage.nullifier == siloed_nullifier;

        !is_spent & valid_in_private
    }

    /// Returns the signing public key (for testing/debugging).
    ///
    /// This reads the key from private storage to verify it was stored correctly.
    #[external("private")]
    fn get_signing_public_key() -> pub (Field, Field) {
        let public_key = self.storage.signing_public_key.get_note();
        (public_key.x, public_key.y)
    }
}
