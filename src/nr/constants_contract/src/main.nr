//! # Initializerless Constants Pattern
//!
//! This module demonstrates the **initializerless constants** pattern for Aztec Noir contracts.
//! Constants are immutable values committed to the contract address via `salt`,
//! eliminating the need for an initializer function for contracts that only need constant values.
//!
//! ## Why Use This Pattern?
//!
//! Traditional immutables in Aztec require `#[storage]` with `PublicImmutable` or
//! `PrivateImmutable`, which:
//! - Requires an initializer function
//! - Incurs storage read costs (~5000+ gates per read)
//! - Constants are stored separately from the contract identity
//!
//! The initializerless pattern:
//! - Commits constants directly in the contract address via `salt`
//! - No initializer needed for purely constant contracts
//! - Constants are cryptographically bound to the contract's identity
//! - Comparable gate cost to storage (~1200 gates difference in benchmarks)
//!
//! ## How It Works
//!
//! 1. **Deployment**: TypeScript generates a random `actual_salt`, computes
//!    `salt = poseidon2_hash([actual_salt, ...serialized_constants])`, and creates
//!    the contract instance with this derived salt.
//!
//! 2. **Capsule Storage**: The TypeScript deployment code pushes `[actual_salt, ...constants]`
//!    to the PXE's capsule storage at a well-known slot.
//!
//! 3. **Runtime Verification**: When `Constants::init()` is called:
//!    - Capsule data `[actual_salt, ...constants]` is loaded (unconstrained oracle)
//!    - The hash is recomputed: `poseidon2_hash(capsule_data)`
//!    - The hash is verified against `salt` from the contract instance
//!    - If verification passes, the constants are guaranteed to be authentic
//!
//! ## Usage Example
//!
//! ```noir
//! use initializerless::constants;
//!
//! #[derive(Deserialize)]
//! #[constants]
//! pub struct Constants {
//!     pub admin_key: Field,
//!     pub protocol_fee: Field,
//! }
//!
//! #[external("private")]
//! fn my_function() {
//!     let constants = Constants::init(self.context);
//!     // Use constants.admin_key, constants.protocol_fee, etc.
//! }
//! ```
//!
//! ## Mixed Usage (Constants + Storage)
//!
//! This contract also demonstrates that constants can coexist with `#[storage]`.
//! Both patterns use different mechanisms:
//! - Constants: verified against `salt`
//! - Storage: managed via state tree and the `#[storage]` macro
//!
//! When using both, the deployer must compute `salt` from both the actual_salt
//! AND the constants struct for verification to succeed.

use aztec::macros::aztec;

/// Constants Contract with Mixed Usage
///
/// Demonstrates the initializerless constants pattern alongside traditional `#[storage]`.
/// See module documentation above for full explanation of the pattern.
#[aztec]
pub contract ConstantsContract {
    use aztec::{
        macros::{functions::{external, initializer, noinitcheck, view}, storage::storage},
        protocol_types::traits::Deserialize,
        state_vars::PublicMutable,
    };
    use initializerless::constants;

    /// Contract storage - demonstrates coexistence with constants pattern
    #[storage]
    struct Storage<Context> {
        /// A simple counter to demonstrate mutable storage
        counter: PublicMutable<u64, Context>,
    }

    /// Developer-defined constants struct.
    ///
    /// The `#[constants]` macro auto-generates `Constants::init(context)`
    /// which loads from capsule storage and verifies against `salt`.
    ///
    /// ## Requirements
    /// - MUST have `#[derive(Deserialize)]` BEFORE `#[constants]` (Serialize is auto-derived)
    /// - All fields must be serializable (Field, integers, nested structs with derives)
    ///
    /// ## Customization
    /// Replace this struct with your own constants. Common examples:
    /// - Account contracts: `signing_public_key: Point`
    /// - Token contracts: `admin: AztecAddress, decimals: u8`
    /// - Protocol contracts: `fee_recipient: AztecAddress, fee_bps: u64`
    #[derive(Deserialize)]
    #[constants]
    pub struct Constants {
        /// X coordinate of the signing public key (Grumpkin curve)
        pub signing_key_x: Field,
        /// Y coordinate of the signing public key (Grumpkin curve)
        pub signing_key_y: Field,
    }

    /// Example private function that uses constants.
    /// This demonstrates how to access constants in a private function.
    /// The constants are loaded and verified on each call.
    ///
    /// `#[noinitcheck]` is required for initializerless deployment because:
    /// - Without an initializer tx, the deployment nullifier doesn't exist
    /// - The default init check would fail when looking for that nullifier
    /// - Constants verification via `salt` provides equivalent security
    #[external("private")]
    #[noinitcheck]
    fn get_signing_key() -> pub (Field, Field) {
        let constants = Constants::init(self.context);
        (constants.signing_key_x, constants.signing_key_y)
    }

    // =========================================================================
    // MIXED USAGE FUNCTIONS - Storage coexisting with Constants
    // =========================================================================

    /// Initializer function for storage.
    /// This sets up mutable storage while constants are handled separately via capsules.
    ///
    /// Note: Even with an initializer, the constants pattern still works because:
    /// - Constants verification uses salt from contract instance
    /// - The deployer must compute salt from BOTH the actual_salt
    ///   AND the serialized constants struct
    #[external("public")]
    #[initializer]
    fn initialize(initial_counter: u64) {
        self.storage.counter.write(initial_counter);
    }

    /// Get the current counter value from storage.
    #[external("public")]
    #[view]
    fn get_counter() -> u64 {
        self.storage.counter.read()
    }

    /// Increment the counter in storage.
    /// Demonstrates that storage remains mutable while constants are immutable.
    #[external("public")]
    fn increment_counter() {
        let current = self.storage.counter.read();
        self.storage.counter.write(current + 1);
    }

    /// Read both constants and storage by enqueuing a public call.
    /// This demonstrates that both systems can coexist and be accessed together.
    ///
    /// Note: Since public storage cannot be directly read from private context,
    /// we enqueue a public call that can read storage. The constants are still
    /// verified in the private function before enqueuing.
    #[external("private")]
    fn verify_constants_and_increment() {
        // Load and verify constants from capsule (this happens in private context)
        let _constants = Constants::init(self.context);

        // Enqueue a public call to interact with storage
        // This demonstrates that after verifying constants privately,
        // we can still interact with public storage
        self.enqueue_self.increment_counter();
    }
}
