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
/// - `Constants::init(context: &mut PrivateContext)` - Loads and verifies constants against contract salt
/// - `Constants::init_unconstrained(context: UtilityContext)` - Unconstrained load without verification
///
/// ## Verification Method
///
/// The capsule stores `[actual_salt, constants.serialize()]` (salt followed by serialized constants).
/// Verification:
/// 1. Load capsule data from storage
/// 2. Compute `salt = poseidon2_hash(capsule_data)`
/// 3. Verify `salt == instance.salt`
///
/// This allows contracts with initializers to use constants without conflicting with `initialization_hash`.
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
/// 1. Loads capsule data (actual_salt followed by serialized constants)
/// 2. Computes `salt = poseidon2_hash(capsule_data)`
/// 3. Verifies `salt` matches `instance.salt`
/// 4. Returns deserialized constants
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

    // Well-known capsule slot for constants storage (first 11 digits of pi)
    let constants_slot: Field = 0x31415926535;

    // Compute serialized length from field types (handles nested structs, arrays, etc.)
    // Pattern from Aztec's derive macros: noir-protocol-circuits/crates/types/src/meta/mod.nr
    let constants_type = s.as_type();
    let (struct_def, generics) = constants_type.as_data_type().unwrap();
    let fields = struct_def.fields(generics);
    let serialized_len = if fields.len() > 0 {
        fields
            .map(|(_, field_type, _): (Quoted, Type, Quoted)| {
                quote { <$field_type as aztec::protocol_types::traits::Serialize>::N }
            })
            .join(quote { + })
    } else {
        quote { 0 }
    };

    quote {
        $serialize_impl
        impl Constants {
            /// Loads and verifies constants from capsule storage.
            ///
            /// ## How it works
            ///
            /// 1. **Load**: Fetches capsule data (actual_salt followed by serialized constants)
            /// 2. **Hash**: Computes `salt = poseidon2_hash(capsule_data)`
            /// 3. **Verify**: Asserts `salt` equals `instance.salt`
            ///
            /// ## Arguments
            ///
            /// * `context` - The PrivateContext reference (use in private functions and contract_library_method)
            ///
            /// ## Panics
            ///
            /// - "Constants do not match contract salt" - wrong constants or actual_salt in capsule
            /// - "Constants not found in capsule" - TypeScript didn't push constants
            pub fn init(context: &mut aztec::context::PrivateContext) -> Constants {
                let address = context.this_address();

                // Load capsule data: [actual_salt, serialized_constants[0], serialized_constants[1], ...]
                // Safety: capsule_data is verified against salt committed in contract address
                let capsule_data: [Field; 1 + $serialized_len] = unsafe {
                    aztec::oracle::capsules::load(address, $constants_slot)
                        .unwrap_or_else(|| panic(f"Constants not found in capsule for contract {address}"))
                };

                // Compute salt from entire capsule data
                let salt = aztec::protocol_types::hash::poseidon2_hash(capsule_data);

                // Get contract instance to access salt
                let instance = aztec::oracle::get_contract_instance::get_contract_instance(address);

                // Verify derived salt matches contract instance salt
                assert_eq(
                    salt,
                    instance.salt,
                    "Constants do not match contract salt",
                );

                // Extract serialized constants (skip first element which is actual_salt)
                let mut serialized_constants: [Field; $serialized_len] = [0; $serialized_len];
                for i in 0..$serialized_len {
                    serialized_constants[i] = capsule_data[i + 1];
                }

                aztec::protocol_types::traits::Deserialize::deserialize(serialized_constants)
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
            /// - "Constants not found in capsule" - TypeScript didn't push constants
            pub unconstrained fn init_unconstrained(context: aztec::context::UtilityContext) -> Constants {
                let address = context.this_address();

                // Load capsule data: [actual_salt, serialized_constants[0], serialized_constants[1], ...]
                let capsule_data: [Field; 1 + $serialized_len] = aztec::oracle::capsules::load(address, $constants_slot)
                    .unwrap_or_else(|| panic(f"Constants not found in capsule for contract {address}"));

                // Extract serialized constants (skip first element which is actual_salt)
                let mut serialized_constants: [Field; $serialized_len] = [0; $serialized_len];
                for i in 0..$serialized_len {
                    serialized_constants[i] = capsule_data[i + 1];
                }

                aztec::protocol_types::traits::Deserialize::deserialize(serialized_constants)
            }
        }
    }
}
