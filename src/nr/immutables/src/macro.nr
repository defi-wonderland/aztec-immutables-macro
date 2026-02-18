/// # Immutables Macro
///
/// This macro auto-generates the verification and loading logic for the immutables pattern,
/// similar to how `#[storage]` works for state variables.
///
/// ## Usage
///
/// ```noir
/// #[immutables]
/// pub struct Immutables {
///     pub signing_key_x: Field,
///     pub signing_key_y: Field,
/// }
/// ```
///
/// ## What It Generates
///
/// - `Serialize` and `Deserialize` implementations (if not already implemented)
/// - `Immutables::init(context: &mut PrivateContext)` - Loads and verifies immutables against contract salt
/// - `Immutables::init_unconstrained(context: UtilityContext)` - Unconstrained load without verification
///
/// ## Verification Method
///
/// The capsule stores a flat array: `[actual_salt, field_0, field_1, ...]` where `field_N` are the
/// serialized immutable fields. Verification:
/// 1. Load capsule data from storage
/// 2. Compute `salt = poseidon2_hash(capsule_data)`
/// 3. Verify `salt == instance.salt`
///
/// This allows contracts with initializers to use immutables without conflicting with `initialization_hash`.
///
/// ## Requirements
///
/// - The struct MUST be named `Immutables`
///
/// ## Future Improvements (for Aztec protocol)
///
/// Currently, immutables must be explicitly loaded in each function:
/// ```noir
/// let immutables = Immutables::init(context);
/// let key = immutables.signing_key_x;
/// ```
///
/// If integrated into aztec-packages, this could work like `#[storage]`:
/// 1. Add a `HAS_IMMUTABLES` comptime registry (similar to storage detection)
/// 2. Modify `#[external]`/`#[internal]` function macros to check for immutables
/// 3. Auto-inject `let immutables = Immutables::init(context);`
/// 4. Make available as `self.immutables`
///
/// This would enable direct access:
/// ```noir
/// #[external("private")]
/// fn my_function() {
///     let key = self.immutables.signing_key_x; // No explicit load needed
/// }
/// ```

/// The `#[immutables]` macro for the immutables pattern.
///
/// This macro:
/// - Validates the struct is named `Immutables`
/// - Derives `Serialize` and `Deserialize` if not already implemented
/// - Generates `init(context: &mut PrivateContext)` for private/contract_library_method functions
/// - Generates `init_unconstrained(context: UtilityContext)` for utility functions
///
/// The generated `init` function (constrained):
/// 1. Loads capsule data (actual_salt followed by serialized immutables)
/// 2. Computes `salt = poseidon2_hash(capsule_data)`
/// 3. Verifies `salt` matches `instance.salt`
/// 4. Returns deserialized immutables
///
/// The generated `init_unconstrained` function (unconstrained):
/// - Loads immutables directly from capsule without verification
/// - Use only in utility functions where verification is not possible
pub comptime fn immutables(s: TypeDefinition) -> Quoted {
    let struct_name = s.name();

    // Validate struct name
    if struct_name != quote { Immutables } {
        panic(
            f"The #[immutables] macro can only be applied to a struct named 'Immutables', got '{struct_name}' instead.",
        )
    }

    // Derive Serialize and Deserialize if not already implemented.
    // derive_deserialize_if_not_implemented also returns the serialized length expression,
    // which we reuse for capsule array sizing (Serialize::N == Deserialize::N for the same struct).
    let serialize_impl = aztec::macros::utils::derive_serialize_if_not_implemented(s);
    let (deserialize_impl, serialized_len) = derive_deserialize_if_not_implemented(s);

    // IMMUTABLES_SLOT: 0x1a0e563e6a2087002308173ed42dec43b9543a3684de63d6be9a958c0eaf5c45
    let IMMUTABLES_SLOT: Field = aztec::protocol::hash::poseidon2_hash_bytes("IMMUTABLES_SLOT".as_bytes());

    quote {
        $serialize_impl
        $deserialize_impl
        impl Immutables {
            /// Loads and verifies immutables from capsule storage.
            ///
            /// ## How it works
            ///
            /// 1. **Load**: Fetches capsule data (actual_salt followed by serialized immutables)
            /// 2. **Hash**: Computes `salt = poseidon2_hash(capsule_data)`
            /// 3. **Verify**: Asserts `salt` equals `instance.salt`
            ///
            /// ## Arguments
            ///
            /// * `context` - The PrivateContext reference (use in private functions and contract_library_method)
            ///
            /// ## Panics
            ///
            /// - "Immutables do not match contract salt" - wrong immutables or actual_salt in capsule
            /// - "Immutables not found in capsule" - TypeScript didn't push immutables
            pub fn init(context: &mut aztec::context::PrivateContext) -> Immutables {
                let address = context.this_address();

                // Load capsule data: [actual_salt, serialized_immutables[0], serialized_immutables[1], ...]
                // Safety: capsule_data is verified against salt committed in contract address
                let capsule_data: [Field; 1 + $serialized_len] = unsafe {
                    aztec::oracle::capsules::load(address, $IMMUTABLES_SLOT)
                        .unwrap_or_else(|| panic(f"Immutables not found in capsule for contract {address}"))
                };

                // Compute salt from entire capsule data
                let salt = aztec::protocol::hash::poseidon2_hash(capsule_data);

                // Get contract instance to access salt
                let instance = aztec::oracle::get_contract_instance::get_contract_instance(address);

                // Verify derived salt matches contract instance salt
                assert_eq(
                    salt,
                    instance.salt,
                    "Immutables do not match contract salt",
                );

                // Extract serialized immutables (skip first element which is actual_salt)
                let mut serialized_immutables: [Field; $serialized_len] = [0; $serialized_len];
                for i in 0..$serialized_len {
                    serialized_immutables[i] = capsule_data[i + 1];
                }

                aztec::protocol::traits::Deserialize::deserialize(serialized_immutables)
            }

            /// Loads immutables from capsule storage without verification.
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
            /// - "Immutables not found in capsule" - TypeScript didn't push immutables
            pub unconstrained fn init_unconstrained(context: aztec::context::UtilityContext) -> Immutables {
                let address = context.this_address();

                // Load capsule data: [actual_salt, serialized_immutables[0], serialized_immutables[1], ...]
                let capsule_data: [Field; 1 + $serialized_len] = aztec::oracle::capsules::load(address, $IMMUTABLES_SLOT)
                    .unwrap_or_else(|| panic(f"Immutables not found in capsule for contract {address}"));

                // Extract serialized immutables (skip first element which is actual_salt)
                let mut serialized_immutables: [Field; $serialized_len] = [0; $serialized_len];
                for i in 0..$serialized_len {
                    serialized_immutables[i] = capsule_data[i + 1];
                }

                aztec::protocol::traits::Deserialize::deserialize(serialized_immutables)
            }

            /// Persists immutables data to the PXE's CapsuleStore after validation.
            ///
            /// Validates that `poseidon2_hash(capsule_data) == instance.salt` before
            /// storing, preventing corrupt data from being persisted. This protects
            /// `init_unconstrained()` which skips verification at read time.
            ///
            /// Call this from a `#[external("utility")]` function in your contract,
            /// then invoke it via `.simulate()` from TypeScript after deployment.
            /// After this, `init()` and `init_unconstrained()` can read immutables
            /// from the persistent store without transient capsules.
            ///
            /// Note: capsule_data is passed as a parameter instead of using capsules::load
            /// because the PXE's utility simulation path does not forward transient capsules
            /// to the UtilityExecutionOracle (hardcoded [] at contract_function_simulator.ts).
            /// See: https://github.com/AztecProtocol/aztec-packages/blob/4047b6e/yarn-project/pxe/src/contract_function_simulator/contract_function_simulator.ts#L275
            /// TODO: Once that changes, switch to capsules::load here and remove the parameter.
            ///
            /// ## Arguments
            ///
            /// * `context` - The UtilityContext (use in utility functions)
            /// * `capsule_data` - Array of `[actual_salt, field_0, field_1, ...]`
            ///
            /// ## Panics
            ///
            /// - "Immutables data does not match contract salt, refusing to store" - capsule_data is invalid
            pub unconstrained fn store(context: aztec::context::UtilityContext, capsule_data: [Field; 1 + $serialized_len]) {
                let address = context.this_address();

                // Validate: hash(capsule_data) must match instance.salt before storing
                let salt = aztec::protocol::hash::poseidon2_hash(capsule_data);
                let instance = aztec::oracle::get_contract_instance::get_contract_instance(address);
                assert_eq(
                    salt,
                    instance.salt,
                    "Immutables data does not match contract salt, refusing to store",
                );

                aztec::oracle::capsules::store(address, $IMMUTABLES_SLOT, capsule_data);
            }
        }
    }
}

/// Generates a `Deserialize` impl for a given struct if not already implemented.
///
/// Returns `(impl_code, serialized_len)` where `serialized_len` is the total field count
/// expression (sum of each field's `Deserialize::N`). This is reused by the `immutables` macro
/// for capsule array sizing, since `Serialize::N == Deserialize::N` for the same struct.
///
/// Based on `derive_deserialize` from aztec-packages:
/// `noir-protocol-circuits/crates/serde/src/serialization.nr`
///
/// We use a custom implementation instead of `aztec::protocol::meta::derive_deserialize` because
/// that function uses an unqualified `Deserialize` reference in `stream_deserialize` for
/// multi-field structs, which requires the trait to be imported at the call site. Since macros
/// cannot emit `use` statements (only functions, structs, globals, and impls), we generate
/// fully-qualified `aztec::protocol::traits::Deserialize` references that work without imports.
comptime fn derive_deserialize_if_not_implemented(s: TypeDefinition) -> (Quoted, Quoted) {
    let typ = s.as_type();
    let (struct_def, generics) = typ.as_data_type().unwrap();
    let params = struct_def.fields(generics);

    let n_expr = if params.len() > 0 {
        params
            .map(|(_, param_type, _): (Quoted, Type, Quoted)| {
                quote { <$param_type as aztec::protocol::traits::Deserialize>::N }
            })
            .join(quote { + })
    } else {
        quote { 0 }
    };

    if s.as_type().implements(quote { aztec::protocol::traits::Deserialize }.as_trait_constraint()) {
        (quote {}, n_expr)
    } else {
        // Build per-field deserialization using index-based array slicing.
        // Each field is deserialized by extracting its range from the input array
        // and calling the fully-qualified Deserialize::deserialize on that slice.
        // We use a for loop instead of .map() because mutable variables cannot be
        // captured in lambdas in Noir comptime.
        let mut offset_components: [Quoted] = &[];
        let mut field_deserialization = quote {};
        for i in 0..params.len() {
            let (name, param_type, _) = params[i];
            let field_n = quote { <$param_type as aztec::protocol::traits::Deserialize>::N };
            let offset_expr = if offset_components.len() == 0 {
                quote { 0 }
            } else {
                offset_components.map(|q: Quoted| q).join(quote { + })
            };
            offset_components = offset_components.push_back(field_n);
            let new_field = quote {
                let $name: $param_type = {
                    let mut field_arr: [Field; $field_n] = [0; $field_n];
                    for i in 0..$field_n {
                        field_arr[i] = fields[$offset_expr + i];
                    }
                    aztec::protocol::traits::Deserialize::deserialize(field_arr)
                };
            };
            field_deserialization = quote { $field_deserialization $new_field };
        }

        let member_names = params
            .map(|(name, _, _): (Quoted, Type, Quoted)| quote { $name })
            .join(quote { , });

        let stream_body = params
            .map(|(name, param_type, _): (Quoted, Type, Quoted)| {
                quote {
                    let $name = <$param_type as aztec::protocol::traits::Deserialize>::stream_deserialize(reader);
                }
            })
            .join(quote {});

        (quote {
            impl aztec::protocol::traits::Deserialize for $typ {
                let N: u32 = $n_expr;

                fn deserialize(fields: [Field; Self::N]) -> Self {
                    $field_deserialization
                    Self { $member_names }
                }

                fn stream_deserialize<let K: u32>(reader: &mut aztec::protocol::utils::reader::Reader<K>) -> Self {
                    $stream_body
                    Self { $member_names }
                }
            }
        }, n_expr)
    }
}