//! # Initializerless Constants Pattern
//!
//! This module demonstrates the **initializerless constants** pattern for Aztec Noir contracts.
//! Constants are immutable values committed to the contract address via `initialization_hash`,
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
//! - Commits constants directly in the contract address via `initialization_hash`
//! - No initializer needed for purely constant contracts
//! - Constants are cryptographically bound to the contract's identity
//! - Comparable gate cost to storage (~1200 gates difference in benchmarks)
//!
//! ## How It Works
//!
//! 1. **Deployment**: Constants are serialized and hashed. This hash becomes part of
//!    `initialization_hash` which is used to compute the contract address.
//!
//! 2. **Capsule Storage**: The TypeScript deployment code pushes the serialized constants
//!    to the PXE's capsule storage at a well-known slot.
//!
//! 3. **Runtime Verification**: When `Constants::load_and_verify()` is called:
//!    - Constants are loaded from capsule storage (unconstrained oracle)
//!    - The hash is recomputed from the loaded values
//!    - The hash is verified against `initialization_hash` from the contract instance
//!    - If verification passes, the constants are guaranteed to be authentic
//!
//! ## Usage Example
//!
//! ```noir
//! use initializerless::constants;
//!
//! #[derive(Serialize, Deserialize)]
//! #[constants]
//! pub struct Constants {
//!     pub admin_key: Field,
//!     pub protocol_fee: Field,
//! }
//!
//! #[external("private")]
//! fn my_function() {
//!     let constants = Constants::load_and_verify(self.address);
//!     // Use constants.admin_key, constants.protocol_fee, etc.
//! }
//! ```
//!
//! ## Mixed Usage (Constants + Storage)
//!
//! This contract also demonstrates that constants can coexist with `#[storage]`.
//! Both patterns use different mechanisms:
//! - Constants: verified against `initialization_hash`
//! - Storage: managed via state tree and the `#[storage]` macro
//!
//! When using both, the `initialization_hash` is computed from both the initializer
//! arguments AND the constants struct.

use aztec::macros::aztec;

/// Constants Contract with Mixed Usage
///
/// Demonstrates the initializerless constants pattern alongside traditional `#[storage]`.
/// See module documentation above for full explanation of the pattern.
#[aztec]
pub contract ConstantsContract {
    use aztec::{
        macros::{functions::{external, initializer, noinitcheck, view}, storage::storage},
        protocol_types::traits::{Deserialize, Serialize},
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
    /// The `#[constants]` macro auto-generates `Constants::load_and_verify(address)`
    /// which loads from capsule storage and verifies against `initialization_hash`.
    ///
    /// ## Requirements
    /// - MUST have `#[derive(Serialize, Deserialize)]` BEFORE `#[constants]`
    /// - All fields must be serializable (Field, integers, nested structs with derives)
    ///
    /// ## Customization
    /// Replace this struct with your own constants. Common examples:
    /// - Account contracts: `signing_public_key: Point`
    /// - Token contracts: `admin: AztecAddress, decimals: u8`
    /// - Protocol contracts: `fee_recipient: AztecAddress, fee_bps: u64`
    #[derive(Serialize, Deserialize)]
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
    /// - Constants verification via `initialization_hash` provides equivalent security
    #[external("private")]
    #[noinitcheck]
    fn get_signing_key() -> pub (Field, Field) {
        let constants = Constants::load_and_verify(self.address);
        (constants.signing_key_x, constants.signing_key_y)
    }

    // =========================================================================
    // MIXED USAGE FUNCTIONS - Storage coexisting with Constants
    // =========================================================================

    /// Initializer function for storage.
    /// This sets up mutable storage while constants are handled separately via capsules.
    ///
    /// Note: Even with an initializer, the constants pattern still works because:
    /// - Constants verification uses initialization_hash from contract instance
    /// - The deployer must compute initialization_hash from BOTH the initializer args
    ///   AND the constants struct
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
        let _constants = Constants::load_and_verify(self.address);

        // Enqueue a public call to interact with storage
        // This demonstrates that after verifying constants privately,
        // we can still interact with public storage
        self.enqueue_self.increment_counter();
    }
}
