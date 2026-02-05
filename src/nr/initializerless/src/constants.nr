/// # Constants Macro for Initializerless Constants Pattern
///
/// This macro auto-generates the boilerplate code for the initializerless constants pattern,
/// similar to how `#[storage]` works for state variables.
///
/// ## Usage
///
/// ```noir
/// #[constants]
/// pub struct Constants {
///     pub signing_key_x: Field,
///     pub signing_key_y: Field,
/// }
/// ```
///
/// ## What It Generates
///
/// - `Serialize` and `Deserialize` implementations (if not already implemented)
/// - `Constants::init(context: &mut PrivateContext)` - Loads and verifies constants against contract salt
/// - `Constants::init_unconstrained(context: UtilityContext)` - Unconstrained load without verification
///
/// ## Verification Method
///
/// The capsule stores a flat array: `[actual_salt, field_0, field_1, ...]` where `field_N` are the
/// serialized constant fields. Verification:
/// 1. Load capsule data from storage
/// 2. Compute `salt = poseidon2_hash(capsule_data)`
/// 3. Verify `salt == instance.salt`
///
/// This allows contracts with initializers to use constants without conflicting with `initialization_hash`.
///
/// ## Requirements
///
/// - The struct MUST be named `Constants`
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
/// - Derives `Serialize` and `Deserialize` if not already implemented
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

    // Derive Serialize and Deserialize if not already implemented
    let serialize_impl = aztec::macros::utils::derive_serialize_if_not_implemented(s);
    let deserialize_impl = derive_deserialize_if_not_implemented(s);

    // Poseidon2 hash of 'CONSTANTS_SLOT': poseidon2_hash_bytes("CONSTANTS_SLOT".as_bytes());
    let CONSTANTS_SLOT: Field = 0x257f7fa8d0b607b4f584f2aa6480ae86716203481e2802444cf05a289cc85b3a;

    // Compute serialized length from field types (handles nested structs, arrays, etc.)
    // Pattern from Aztec's derive macros: noir-protocol-circuits/crates/types/src/meta/mod.nr
    let constants_type = s.as_type();
    let (struct_def, generics) = constants_type.as_data_type().unwrap();
    let fields = struct_def.fields(generics);
    let serialized_len = if fields.len() > 0 {
        fields
            .map(|(_, field_type, _): (Quoted, Type, Quoted)| {
                quote { <$field_type as aztec::protocol::traits::Serialize>::N }
            })
            .join(quote { + })
    } else {
        quote { 0 }
    };

    quote {
        $serialize_impl
        $deserialize_impl
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
                    aztec::oracle::capsules::load(address, $CONSTANTS_SLOT)
                        .unwrap_or_else(|| panic(f"Constants not found in capsule for contract {address}"))
                };

                // Compute salt from entire capsule data
                let salt = aztec::protocol::hash::poseidon2_hash(capsule_data);

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

                aztec::protocol::traits::Deserialize::deserialize(serialized_constants)
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
                let capsule_data: [Field; 1 + $serialized_len] = aztec::oracle::capsules::load(address, $CONSTANTS_SLOT)
                    .unwrap_or_else(|| panic(f"Constants not found in capsule for contract {address}"));

                // Extract serialized constants (skip first element which is actual_salt)
                let mut serialized_constants: [Field; $serialized_len] = [0; $serialized_len];
                for i in 0..$serialized_len {
                    serialized_constants[i] = capsule_data[i + 1];
                }

                aztec::protocol::traits::Deserialize::deserialize(serialized_constants)
            }
        }
    }
}

/// Generates a quote that implements `Deserialize` for a given struct `s`. If the struct already implements
/// `Deserialize`, we return an empty quote.
///
/// Mirrors `aztec::macros::utils::derive_serialize_if_not_implemented` but for `Deserialize`.
comptime fn derive_deserialize_if_not_implemented(s: TypeDefinition) -> Quoted {
    if s.as_type().implements(quote { aztec::protocol::traits::Deserialize }.as_trait_constraint()) {
        quote {}
    } else {
        aztec::protocol::meta::derive_deserialize(s)
    }
}