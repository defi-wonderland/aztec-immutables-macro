use crate::ImmutablesContract;
use crate::test::utils::setup_with_initializer;

// TODO: The TXE does not support deploying contracts with a custom salt.
// The verify_immutables_and_increment function loads immutables in private context
// (which requires salt verification) before enqueuing a public call.
// Since the TXE can't set a custom salt, the immutables verification always fails.
//
// See: https://github.com/AztecProtocol/aztec-packages/issues/16656
// Full mixed usage is tested in TypeScript E2E tests (src/ts/immutables-contract.test.ts).

// #[test]
#[allow(dead_code)]
unconstrained fn verify_immutables_and_increment_success() {
    let initial_counter: u64 = 42;
    let (mut env, contract_address) = setup_with_initializer(initial_counter);

    // This would:
    // 1. Store capsule data with correct immutables
    // 2. Call verify_immutables_and_increment() which:
    //    a. Verifies immutables in private context (fails due to salt mismatch)
    //    b. Enqueues increment_counter() in public context
    // 3. Assert counter == initial_counter + 1
    //
    // Cannot work until the TXE allows deploying with a specific salt.
    let caller = env.create_light_account();
    env.call_private(
        caller,
        ImmutablesContract::at(contract_address).verify_immutables_and_increment(),
    );
}

/// Storage-only tests work fine since they don't depend on salt verification.
#[test]
unconstrained fn increment_counter_success() {
    let initial_counter: u64 = 42;
    let (mut env, contract_address) = setup_with_initializer(initial_counter);

    let caller = env.create_light_account();
    env.call_public(caller, ImmutablesContract::at(contract_address).increment_counter());

    let counter = env.view_public(ImmutablesContract::at(contract_address).get_counter());
    assert(counter == initial_counter + 1);
}
