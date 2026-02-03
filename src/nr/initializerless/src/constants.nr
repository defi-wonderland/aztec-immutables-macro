/// # Constants Macro for Initializerless Constants Pattern
///
/// This macro auto-generates the boilerplate code for the initializerless constants pattern,
/// similar to how `#[storage]` works for state variables.
///
/// ## Usage
///
/// ```noir
/// #[derive(Deserialize)]
/// #[constants]
/// pub struct Constants {
///     pub signing_key_x: Field,
///     pub signing_key_y: Field,
/// }
/// ```
///
/// ## What It Generates
///
/// - `Serialize` implementation (if not already implemented)
/// - `Constants::init(context: &mut PrivateContext)` - Loads and verifies constants (for private/contract_library_method)
/// - `Constants::init_unconstrained(context: UtilityContext)` - Unconstrained load without verification (for utility functions)
///
/// ## Requirements
///
/// - The struct MUST be named `Constants`
/// - `#[derive(Deserialize)]` is required (for capsule loading)
///
/// ## Future Improvements (for Aztec protocol)
///
/// Currently, constants must be explicitly loaded in each function:
/// ```noir
/// let constants = Constants::init(context);
/// let key = constants.signing_key_x;
/// ```
///
/// If integrated into aztec-packages, this could work like `#[storage]`:
/// 1. Add a `HAS_CONSTANTS` comptime registry (similar to storage detection)
/// 2. Modify `#[external]`/`#[internal]` function macros to check for constants
/// 3. Auto-inject `let constants = Constants::init(context);`
/// 4. Make available as `self.constants`
///
/// This would enable direct access:
/// ```noir
/// #[external("private")]
/// fn my_function() {
///     let key = self.constants.signing_key_x; // No explicit load needed
/// }
/// ```

/// The `#[constants]` macro for initializerless constants pattern.
///
/// This macro:
/// - Validates the struct is named `Constants`
/// - Derives `Serialize` if not already implemented
/// - Generates `init(context: &mut PrivateContext)` for private/contract_library_method functions
/// - Generates `init_unconstrained(context: UtilityContext)` for utility functions
///
/// The generated `init` function (constrained):
/// 1. Loads constants from capsule storage (unconstrained oracle)
/// 2. Gets the contract instance to access `initialization_hash`
/// 3. Recomputes hash from loaded constants
/// 4. Verifies hash matches `initialization_hash`
/// 5. Returns verified constants
///
/// The generated `init_unconstrained` function (unconstrained):
/// - Loads constants directly from capsule without verification
/// - Use only in utility functions where verification is not possible
pub comptime fn constants(s: TypeDefinition) -> Quoted {
    let struct_name = s.name();

    // Validate struct name
    if struct_name != quote { Constants } {
        panic(
            f"The #[constants] macro can only be applied to a struct named 'Constants', got '{struct_name}' instead.",
        )
    }

    // Derive Serialize if not already implemented
    let serialize_impl = aztec::macros::utils::derive_serialize_if_not_implemented(s);

    // Well-known capsule slot for constants storage
    // Value: first 11 digits of pi (0x31415926535) - deterministic, collision-resistant
    let constants_slot: Field = 0x31415926535;

    // Generate the implementation with inlined slot value
    quote {
        $serialize_impl
        impl Constants {
            /// Loads and verifies constants from capsule storage.
            ///
            /// ## How it works
            ///
            /// 1. **Load**: Fetches serialized constants from capsule storage (unconstrained oracle)
            /// 2. **Instance**: Gets the contract instance containing `initialization_hash`
            /// 3. **Hash**: Recomputes `poseidon2_hash(constants.serialize())`
            /// 4. **Verify**: Asserts computed hash equals `initialization_hash`
            ///
            /// ## Arguments
            ///
            /// * `context` - The PrivateContext reference (use in private functions and contract_library_method)
            ///
            /// ## Panics
            ///
            /// - "Constants do not match initialization hash" - wrong constants in capsule
            /// - Unwrap panic if capsule is empty (TypeScript didn't push constants)
            pub fn init(context: &mut aztec::context::PrivateContext) -> Constants {
                let address = context.this_address();

                // Safety: verified against initialization_hash committed in contract address
                let constants: Constants = unsafe {
                    aztec::oracle::capsules::load(address, $constants_slot).unwrap()
                };

                // Get contract instance to access initialization_hash
                let instance = aztec::oracle::get_contract_instance::get_contract_instance(address);

                // Recompute commitment from loaded constants
                let serialized_constants = aztec::protocol_types::traits::Serialize::serialize(constants);
                let constants_commitment = aztec::protocol_types::hash::poseidon2_hash(serialized_constants);

                // Verify loaded constants match what was committed in address
                assert_eq(
                    constants_commitment,
                    instance.initialization_hash,
                    "Constants do not match initialization hash",
                );

                constants
            }

            /// Loads constants from capsule storage without verification.
            ///
            /// **WARNING**: This is unconstrained and provides NO security guarantees.
            /// Use only in utility/unconstrained functions where verification is not possible.
            ///
            /// For constrained contexts (private functions), use `init` instead.
            ///
            /// ## Arguments
            ///
            /// * `context` - The UtilityContext (use in utility functions)
            ///
            /// ## Panics
            ///
            /// - Unwrap panic if capsule is empty (TypeScript didn't push constants)
            pub unconstrained fn init_unconstrained(context: aztec::context::UtilityContext) -> Constants {
                let address = context.this_address();
                aztec::oracle::capsules::load(address, $constants_slot).unwrap()
            }
        }
    }
}
