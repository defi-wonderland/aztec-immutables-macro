//! # Initializerless Immutables Pattern
//!
//! This module demonstrates the **initializerless immutables** pattern for Aztec Noir contracts.
//! Immutables are values committed to the contract address via `salt`,
//! eliminating the need for an initializer function for contracts that only need immutable values.
//!
//! ## Why Use This Pattern?
//!
//! Traditional immutables in Aztec require `#[storage]` with `PublicImmutable` or
//! `PrivateImmutable`, which:
//! - Requires an initializer function
//! - Incurs storage read costs (~5000+ gates per read)
//! - Immutables are stored separately from the contract identity
//!
//! The initializerless pattern:
//! - Commits immutables directly in the contract address via `salt`
//! - No initializer needed for purely immutable contracts
//! - Immutables are cryptographically bound to the contract's identity
//! - Comparable gate cost to storage (~1200 gates difference in benchmarks)
//!
//! ## How It Works
//!
//! 1. **Deployment**: TypeScript generates a random `actual_salt`, computes
//!    `salt = poseidon2_hash([actual_salt, ...serialized_immutables])`, and creates
//!    the contract instance with this derived salt.
//!
//! 2. **Capsule Storage**: The TypeScript deployment code pushes `[actual_salt, ...immutables]`
//!    to the PXE's capsule storage at a well-known slot.
//!
//! 3. **Runtime Verification**: When `Immutables::init()` is called:
//!    - Capsule data `[actual_salt, ...immutables]` is loaded (unconstrained oracle)
//!    - The hash is recomputed: `poseidon2_hash(capsule_data)`
//!    - The hash is verified against `salt` from the contract instance
//!    - If verification passes, the immutables are guaranteed to be authentic
//!
//! ## Usage Example
//!
//! ```noir
//! use immutables::immutables;
//!
//! #[immutables]
//! pub struct Immutables {
//!     pub admin_key: Field,
//!     pub protocol_fee: Field,
//! }
//!
//! #[external("private")]
//! fn my_function() {
//!     let immutables = Immutables::init(self.context);
//!     // Use immutables.admin_key, immutables.protocol_fee, etc.
//! }
//! ```
//!
//! ## Mixed Usage (Immutables + Storage)
//!
//! This contract also demonstrates that immutables can coexist with `#[storage]`.
//! Both patterns use different mechanisms:
//! - Immutables: verified against `salt`
//! - Storage: managed via state tree and the `#[storage]` macro
//!
//! When using both, the deployer must compute `salt` from both the actual_salt
//! AND the immutables struct for verification to succeed.

use aztec::macros::aztec;

/// Immutables Contract with Mixed Usage
///
/// Demonstrates the initializerless immutables pattern alongside traditional `#[storage]`.
/// See module documentation above for full explanation of the pattern.
#[aztec]
pub contract ImmutablesContract {
    use aztec::{
        macros::{functions::{external, initializer, noinitcheck, view}, storage::storage},
        state_vars::PublicMutable,
    };
    use immutables::immutables;

    /// Contract storage - demonstrates coexistence with immutables pattern
    #[storage]
    struct Storage<Context> {
        /// A simple counter to demonstrate mutable storage
        counter: PublicMutable<u64, Context>,
    }

    /// Developer-defined immutables struct.
    ///
    /// The `#[immutables]` macro auto-generates `Immutables::init(context)`
    /// which loads from capsule storage and verifies against `salt`.
    ///
    /// ## Requirements
    /// - All fields must be serializable (Field, integers, nested structs with derives)
    ///
    /// ## Customization
    /// Replace this struct with your own immutables. Common examples:
    /// - Account contracts: `signing_public_key: Point`
    /// - Token contracts: `admin: AztecAddress, decimals: u8`
    /// - Protocol contracts: `fee_recipient: AztecAddress, fee_bps: u64`
    #[immutables]
    pub struct Immutables {
        /// X coordinate of the signing public key (Grumpkin curve)
        pub signing_key_x: Field,
        /// Y coordinate of the signing public key (Grumpkin curve)
        pub signing_key_y: Field,
    }

    /// Example private function that uses immutables.
    /// This demonstrates how to access immutables in a private function.
    /// The immutables are loaded and verified on each call.
    ///
    /// `#[noinitcheck]` is required for initializerless deployment because:
    /// - Without an initializer tx, the deployment nullifier doesn't exist
    /// - The default init check would fail when looking for that nullifier
    /// - Immutables verification via `salt` provides equivalent security
    #[external("private")]
    #[noinitcheck]
    fn get_signing_key() -> pub (Field, Field) {
        let immutables = Immutables::init(self.context);
        (immutables.signing_key_x, immutables.signing_key_y)
    }

    // =========================================================================
    // MIXED USAGE FUNCTIONS - Storage coexisting with Immutables
    // =========================================================================

    /// Initializer function for storage.
    /// This sets up mutable storage while immutables are handled separately via capsules.
    ///
    /// Note: Even with an initializer, the immutables pattern still works because:
    /// - Immutables verification uses salt from contract instance
    /// - The deployer must compute salt from BOTH the actual_salt
    ///   AND the serialized immutables struct
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
    /// Demonstrates that storage remains mutable while immutables are immutable.
    #[external("public")]
    fn increment_counter() {
        let current = self.storage.counter.read();
        self.storage.counter.write(current + 1);
    }

    /// Read both immutables and storage by enqueuing a public call.
    /// This demonstrates that both systems can coexist and be accessed together.
    ///
    /// Note: Since public storage cannot be directly read from private context,
    /// we enqueue a public call that can read storage. The immutables are still
    /// verified in the private function before enqueuing.
    #[external("private")]
    fn verify_immutables_and_increment() {
        // Load and verify immutables from capsule (this happens in private context)
        let _immutables = Immutables::init(self.context);

        // Enqueue a public call to interact with storage
        // This demonstrates that after verifying immutables privately,
        // we can still interact with public storage
        self.enqueue_self.increment_counter();
    }
}
