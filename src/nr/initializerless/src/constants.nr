/// # Constants Macro for Initializerless Constants Pattern
///
/// This macro auto-generates the boilerplate code for the initializerless constants pattern,
/// similar to how `#[storage]` works for state variables.
///
/// ## Usage
///
/// ```noir
/// #[derive(Serialize, Deserialize)]
/// #[constants]
/// pub struct Constants {
///     pub signing_key_x: Field,
///     pub signing_key_y: Field,
/// }
/// ```
///
/// **Important**: `#[derive(Serialize, Deserialize)]` must come BEFORE `#[constants]`
/// so the traits are implemented before the macro validates them.
///
/// ## What It Generates
///
/// - `Constants::init(address)` - Loads and verifies constants (for private/public functions)
/// - `Constants::init_unconstrained(address)` - Unconstrained load without verification (for utility functions)
/// - `Constants::to_public_key(self)` - (Only if struct has `signing_key_x` and `signing_key_y` fields)
///
/// ## Requirements
///
/// - The struct MUST be named `Constants`
/// - `#[derive(Serialize, Deserialize)]` MUST come BEFORE `#[constants]`
///
/// ## Future Improvements (for Aztec protocol)
///
/// Currently, constants must be explicitly loaded in each function:
/// ```noir
/// let constants = Constants::init(self.address);
/// let key = constants.signing_key_x;
/// ```
///
/// If integrated into aztec-packages, this could work like `#[storage]`:
/// 1. Add a `HAS_CONSTANTS` comptime registry (similar to storage detection)
/// 2. Modify `#[external]`/`#[internal]` function macros to check for constants
/// 3. Auto-inject `let constants = Constants::init(context.this_address());`
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
/// - Validates no conflicting `#[storage]` attribute
/// - Validates struct is not empty
/// - Validates all fields implement `Serialize` (catches nested structs)
/// - Generates `init()` for constrained contexts (private/public)
/// - Generates `init_unconstrained()` for unconstrained contexts (utility)
/// - Generates `to_public_key()` if struct has `signing_key_x` and `signing_key_y` fields
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

    // Check for conflicting attributes
    assert(
        !s.has_named_attribute("storage"),
        "Cannot apply both #[constants] and #[storage] to the same struct.",
    );

    // Check struct is not empty
    let fields = s.fields_as_written();
    assert(
        fields.len() > 0,
        "Constants struct cannot be empty. Add at least one field.",
    );

    // Validate all fields implement Serialize (catches nested structs without derives)
    let serialize_constraint = quote { aztec::protocol_types::traits::Serialize }.as_trait_constraint();
    for field in fields {
        let (field_name, field_type, _) = field;
        assert(
            field_type.implements(serialize_constraint),
            f"Field '{field_name}' of type {field_type} does not implement Serialize. Add #[derive(Serialize)] to nested structs.",
        );
    }

    // Note: We don't check if the Constants struct itself implements Serialize/Deserialize
    // because the #[derive] macro may not have completed before this macro runs.
    // The field-level checks above catch nested structs, and the compiler will error
    // naturally if the traits aren't implemented when serialize()/deserialize() is called.
    // TODO: consider using aztec::macros::utils::derive_serialize_if_not_implemented
    // TODO: consider creating derive_deserialize_if_not_implemented

    // Well-known capsule slot for constants storage
    // Value: first 11 digits of pi (0x31415926535) - deterministic, collision-resistant
    // TODO: consider deriving from poseidon2_hash("CONSTANTS_SLOT") or similar
    let constants_slot: Field = 0x31415926535;

    // Check if struct has signing_key_x and signing_key_y fields (for account contracts)
    // If so, generate a to_public_key() helper
    let has_signing_key_x = fields.any(|(name, typ, _)| (name == quote { signing_key_x }) & typ.is_field());
    let has_signing_key_y = fields.any(|(name, typ, _)| (name == quote { signing_key_y }) & typ.is_field());
    let to_public_key_impl = if has_signing_key_x & has_signing_key_y {
        quote {
            /// Converts the signing key constants to an EmbeddedCurvePoint for signature verification.
            /// Auto-generated because struct has `signing_key_x` and `signing_key_y` fields.
            pub fn to_public_key(self) -> std::embedded_curve_ops::EmbeddedCurvePoint {
                std::embedded_curve_ops::EmbeddedCurvePoint {
                    x: self.signing_key_x,
                    y: self.signing_key_y,
                    is_infinite: false,
                }
            }
        }
    } else {
        quote {}
    };

    // Generate the implementation with inlined slot value
    quote {
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
            /// * `address` - The contract address to load constants for (usually `self.address`)
            ///
            /// ## Panics
            ///
            /// - "Constants do not match initialization hash" - wrong constants in capsule
            /// - Unwrap panic if capsule is empty (TypeScript didn't push constants)
            pub fn init(address: aztec::protocol_types::address::AztecAddress) -> Constants {
                // Safety: verified against initialization_hash committed in contract address
                let constants: Constants = unsafe {
                    aztec::oracle::capsules::load(address, $constants_slot).unwrap()
                };

                // Get contract instance to access initialization_hash
                let instance = aztec::oracle::get_contract_instance::get_contract_instance(address);

                // Recompute commitment from loaded constants
                let serialized_constants = constants.serialize();
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
            /// For constrained contexts (private/public functions), use `init` instead.
            ///
            /// ## Arguments
            ///
            /// * `address` - The contract address to load constants for
            ///
            /// ## Panics
            ///
            /// - Unwrap panic if capsule is empty (TypeScript didn't push constants)
            pub unconstrained fn init_unconstrained(address: aztec::protocol_types::address::AztecAddress) -> Constants {
                aztec::oracle::capsules::load(address, $constants_slot).unwrap()
            }

            $to_public_key_impl
        }
    }
}
