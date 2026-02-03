//! # Schnorr Constants Account Contract
//!
//! An account contract using Schnorr signatures for authentication with the
//! **initializerless constants** pattern. The signing public key is committed
//! via `initialization_hash` rather than stored in private immutable storage.
//!
//! ## Benefits over Standard SchnorrAccount
//!
//! 1. **No initializer required**: Contract can be deployed without an initializer tx
//! 2. **Key bound to address**: The public key is cryptographically part of the contract address
//! 3. **Simpler deployment**: No need to manage private note delivery for the key
//!
//! ## How It Works
//!
//! 1. **Deployment**: TypeScript computes `initialization_hash = poseidon2_hash(signing_key_x, signing_key_y)`
//! 2. **Registration**: Contract is registered and published with this hash
//! 3. **Capsule**: The serialized key is stored in capsule storage for runtime access
//! 4. **Verification**: Each auth call loads the key from capsule and verifies against `initialization_hash`
//!
//! ## Security Model
//!
//! The signing key is loaded from an unconstrained oracle (capsule storage), but security
//! is guaranteed because:
//! - `initialization_hash` is part of the contract address computation
//! - An attacker cannot forge a key that produces the same contract address
//! - If wrong key is provided, the poseidon2 hash won't match `initialization_hash`

use aztec::macros::aztec;

#[aztec]
pub contract SchnorrConstantsAccount {
    use dep::aztec::{
        authwit::{
            account::AccountActions,
            auth::{compute_authwit_message_hash, compute_authwit_nullifier},
            entrypoint::app::AppPayload,
        },
        context::PrivateContext,
        hash::compute_siloed_nullifier,
        macros::functions::{external, nophasecheck, view},
        oracle::{
            auth_witness::get_auth_witness,
            get_nullifier_membership_witness::get_low_nullifier_membership_witness,
            notes::set_sender_for_tags,
        },
        protocol_types::{address::AztecAddress, traits::{Deserialize, Serialize}},
    };
    use initializerless::constants;

    /// Constants struct containing the signing public key.
    ///
    /// The key is stored as two Field elements representing the (x, y) coordinates
    /// of a point on the Grumpkin embedded curve.
    #[derive(Serialize, Deserialize)]
    #[constants]
    pub struct Constants {
        /// X coordinate of the signing public key
        pub signing_key_x: Field,
        /// Y coordinate of the signing public key
        pub signing_key_y: Field,
    }

    /// Account entrypoint - executes authenticated actions.
    ///
    /// @dev If you globally change the entrypoint signature, update account_entrypoint.ts
    #[external("private")]
    #[nophasecheck]
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
    /// 1. Load and verify the signing public key from constants
    /// 2. Load the auth witness (signature) from oracle
    /// 3. Verify Schnorr signature of the outer_hash
    #[contract_library_method]
    fn is_valid_impl(context: &mut PrivateContext, outer_hash: Field) -> bool {
        // Load and verify public key from constants
        let constants = Constants::init(context);
        let pub_key = constants.to_public_key();

        // Load auth witness (signature)
        // Safety: The witness is only used as a "magical value" that makes the
        // signature verification below pass. Hence it's safe.
        let witness: [Field; 64] = unsafe { get_auth_witness(outer_hash) };
        let mut signature: [u8; 64] = [0; 64];
        for i in 0..64 {
            signature[i] = witness[i] as u8;
        }

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
        // Load constants (unconstrained, no verification needed for simulation)
        let constants = Constants::init_unconstrained(self.context);
        let pub_key = constants.to_public_key();

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

        let valid_in_private =
            schnorr::verify_signature(pub_key, signature, message_hash.to_be_bytes::<32>());

        // Check if the authwit has already been consumed
        let nullifier = compute_authwit_nullifier(self.address, inner_hash);
        let siloed_nullifier = compute_siloed_nullifier(consumer, nullifier);
        let lower_wit =
            get_low_nullifier_membership_witness(self.context.block_number(), siloed_nullifier);
        let is_spent = lower_wit.leaf_preimage.nullifier == siloed_nullifier;

        !is_spent & valid_in_private
    }

    /// Returns the signing public key (for testing/debugging).
    ///
    /// This is a utility function to verify the constants are loaded correctly.
    #[external("private")]
    fn get_signing_public_key() -> pub (Field, Field) {
        let constants = Constants::init(self.context);
        (constants.signing_key_x, constants.signing_key_y)
    }
}
