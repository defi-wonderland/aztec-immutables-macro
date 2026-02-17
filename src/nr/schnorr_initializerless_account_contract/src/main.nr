//! # Schnorr Initializerless Account Contract
//!
//! An account contract using Schnorr signatures for authentication with the
//! **initializerless immutables** pattern. The signing public key is committed
//! via `salt` rather than stored in private immutable storage.
//!
//! ## Benefits over Standard SchnorrAccount
//!
//! 1. **No initializer required**: Contract can be deployed without an initializer tx
//! 2. **Key bound to address**: The public key is cryptographically part of the contract address
//! 3. **Simpler deployment**: No need to manage private note delivery for the key
//!
//! ## How It Works
//!
//! 1. **Deployment**: TypeScript computes `salt = poseidon2_hash([actual_salt, public_key.x, public_key.y])`
//! 2. **Registration**: Contract is registered and published with this salt
//! 3. **Capsule**: The actual_salt and serialized key are stored in capsule storage for runtime access
//! 4. **Verification**: Each auth call loads from capsule and verifies against `salt`
//!
//! ## Security Model
//!
//! The signing key is loaded from an unconstrained oracle (capsule storage), but security
//! is guaranteed because:
//! - `salt` is part of the contract address computation
//! - An attacker cannot forge a key that produces the same contract address
//! - If wrong key is provided, the poseidon2 hash won't match `salt`

mod public_key;

use aztec::macros::aztec;

#[aztec]
pub contract SchnorrInitializerlessAccount {
    use aztec::{
        authwit::{
            account::AccountActions,
            auth::{compute_authwit_message_hash, compute_authwit_nullifier},
            entrypoint::app::AppPayload,
        },
        context::PrivateContext,
        hash::compute_siloed_nullifier,
        macros::functions::{allow_phase_change, external, view},
        oracle::{
            auth_witness::get_auth_witness,
            get_nullifier_membership_witness::get_low_nullifier_membership_witness,
            notes::set_sender_for_tags,
        },
        protocol::address::AztecAddress,
    };

    use crate::public_key::PublicKey;

    use immutables::immutables;

    /// Immutables struct containing the signing public key.
    #[immutables]
    pub struct Immutables {
        /// The signing public key (x, y coordinates on the Grumpkin curve)
        pub public_key: PublicKey,
    }

    /// Account entrypoint - executes authenticated actions.
    ///
    /// @dev If you globally change the entrypoint signature, update account_entrypoint.ts
    #[external("private")]
    #[allow_phase_change]
    fn entrypoint(app_payload: AppPayload, fee_payment_method: u8, cancellable: bool) {
        // Safety: set_sender_for_tags is an oracle call that registers this account
        // as the sender for private note delivery in nested calls. Required for
        // contracts like Token to be able to create notes owned by this account.
        unsafe { set_sender_for_tags(self.address) };

        let actions = AccountActions::init(self.context, is_valid_impl);
        actions.entrypoint(app_payload, fee_payment_method, cancellable);
    }

    /// Verifies a private authorization witness.
    ///
    /// Returns the IS_VALID selector if the signature is valid.
    #[external("private")]
    #[view]
    fn verify_private_authwit(inner_hash: Field) -> Field {
        let actions = AccountActions::init(self.context, is_valid_impl);
        actions.verify_private_authwit(inner_hash)
    }

    /// Core signature verification logic.
    ///
    /// This is called by AccountActions to verify that the caller has
    /// authorization to perform the requested action.
    ///
    /// ## Process
    ///
    /// 1. Load and verify the signing public key from immutables
    /// 2. Load the auth witness (signature) from oracle
    /// 3. Verify Schnorr signature of the outer_hash
    #[contract_library_method]
    fn is_valid_impl(context: &mut PrivateContext, outer_hash: Field) -> bool {
        // Load and verify public key from immutables
        let immutables = Immutables::init(context);
        let public_key = immutables.public_key;

        // Load auth witness (signature)
        // Safety: The witness is only used as a "magical value" that makes the
        // signature verification below pass. Hence it's safe.
        let witness: [Field; 64] = unsafe { get_auth_witness(outer_hash) };
        let mut signature: [u8; 64] = [0; 64];
        for i in 0..64 {
            signature[i] = witness[i] as u8;
        }

        let pub_key = std::embedded_curve_ops::EmbeddedCurvePoint {
            x: public_key.x,
            y: public_key.y,
            is_infinite: false,
        };

        // Verify Schnorr signature of the payload
        schnorr::verify_signature(pub_key, signature, outer_hash.to_be_bytes::<32>())
    }

    /// Helper to check validity of private authwitnesses (unconstrained).
    ///
    /// This is used by wallets to check if an authwit is valid before sending.
    ///
    /// ## Arguments
    ///
    /// * `consumer` - The address that will consume the authwit
    /// * `inner_hash` - The inner hash of the message to check
    ///
    /// ## Returns
    ///
    /// True if the authwit is valid and not yet consumed, false otherwise.
    #[external("utility")]
    unconstrained fn lookup_validity(consumer: AztecAddress, inner_hash: Field) -> bool {
        // Load immutables (unconstrained, no verification needed for simulation)
        let immutables = Immutables::init_unconstrained(self.context);
        let public_key = immutables.public_key;

        let message_hash = compute_authwit_message_hash(
            consumer,
            self.context.chain_id(),
            self.context.version(),
            inner_hash,
        );

        let witness: [Field; 64] = get_auth_witness(message_hash);
        let mut signature: [u8; 64] = [0; 64];
        for i in 0..64 {
            signature[i] = witness[i] as u8;
        }

        let pub_key = std::embedded_curve_ops::EmbeddedCurvePoint {
            x: public_key.x,
            y: public_key.y,
            is_infinite: false,
        };

        let valid_in_private =
            schnorr::verify_signature(pub_key, signature, message_hash.to_be_bytes::<32>());

        // Check if the authwit has already been consumed
        let nullifier = compute_authwit_nullifier(self.address, inner_hash);
        let siloed_nullifier = compute_siloed_nullifier(consumer, nullifier);
        let lower_wit =
            get_low_nullifier_membership_witness(self.context.block_header(), siloed_nullifier);
        let is_spent = lower_wit.leaf_preimage.nullifier == siloed_nullifier;

        !is_spent & valid_in_private
    }

    /// Returns the signing public key (for testing/debugging).
    ///
    /// This is a utility function to verify the immutables are loaded correctly.
    #[external("private")]
    fn get_signing_public_key() -> pub (Field, Field) {
        let immutables = Immutables::init(self.context);
        let public_key = immutables.public_key;
        (public_key.x, public_key.y)
    }
}
