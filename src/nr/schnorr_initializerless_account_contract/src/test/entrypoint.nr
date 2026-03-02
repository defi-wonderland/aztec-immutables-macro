use crate::SchnorrInitializerlessAccount;
use crate::test::utils::setup;

// TODO: The TXE (Test Execution Environment) does not support deploying contracts
// with a custom salt. Every function in this account contract depends on
// `Immutables::init()`, which verifies capsule data against the contract salt:
//   salt = poseidon2_hash([actual_salt, public_key.x, public_key.y])
//
// Since the TXE assigns a default salt, all immutables verification fails with
// "Immutables do not match contract salt". No functions in this contract can be
// tested until the TXE supports custom salt deployment.
//
// See: https://github.com/AztecProtocol/aztec-packages/issues/16656
// Full account contract testing is done in TypeScript E2E tests
// (src/ts/schnorr-initializerless-account.test.ts).

// #[test]
#[allow(dead_code)]
unconstrained fn get_signing_public_key_success() {
    let (mut env, contract_address) = setup();

    // This would:
    // 1. Store capsule data [actual_salt, public_key.x, public_key.y] via store_immutables
    // 2. Call get_signing_public_key() which loads and verifies immutables against salt
    // 3. Assert the returned key matches the stored values
    //
    // Cannot work until the TXE allows deploying with a specific salt.
    let caller = env.create_light_account();
    let _result = env.call_private(
        caller,
        SchnorrInitializerlessAccount::at(contract_address).get_signing_public_key(),
    );
}
