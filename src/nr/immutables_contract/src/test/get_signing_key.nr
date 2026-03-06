use crate::ImmutablesContract;
use crate::test::utils::setup;

// TODO: The TXE (Test Execution Environment) does not support deploying contracts
// with a custom salt. The immutables pattern requires:
//   salt = poseidon2_hash([actual_salt, ...serialized_immutables])
// Since the TXE assigns a default salt, Immutables::init() will always fail with
// "Immutables do not match contract salt" because the hash of the capsule data
// won't match the contract instance's salt.
//
// These tests should be enabled once the TXE supports custom salt deployment.
// See: https://github.com/AztecProtocol/aztec-packages/issues/16656
//
// Full immutables verification is tested in TypeScript E2E tests (src/ts/immutables-contract.test.ts).

// #[test]
#[allow(dead_code)]
unconstrained fn get_signing_key_success() {
    let (mut env, contract_address) = setup();

    // This would:
    // 1. Store capsule data [actual_salt, signing_key_x, signing_key_y] via store_immutables
    // 2. Call get_signing_key() which loads and verifies immutables against salt
    // 3. Assert the returned key matches the stored values
    //
    // Cannot work until the TXE allows deploying with a specific salt so that
    // poseidon2_hash(capsule_data) == instance.salt holds.
    let caller = env.create_light_account();
    let _result =
        env.call_private(caller, ImmutablesContract::at(contract_address).get_signing_key());
}

// #[test(should_fail_with = "Immutables do not match contract salt")]
#[allow(dead_code)]
unconstrained fn get_signing_key_wrong_capsule_fails() {
    let (mut env, contract_address) = setup();

    // This would:
    // 1. Store capsule data with wrong immutables values
    // 2. Call get_signing_key() which should fail salt verification
    //
    // Cannot work until the TXE allows deploying with a specific salt.
    let caller = env.create_light_account();
    let _result =
        env.call_private(caller, ImmutablesContract::at(contract_address).get_signing_key());
}
