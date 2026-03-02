use aztec::protocol::address::AztecAddress;
use aztec::test::helpers::test_environment::TestEnvironment;

/// Deploys the SchnorrInitializerlessAccount contract and returns the environment and address.
///
/// Note: The TXE does not support custom salt values, so the contract is deployed
/// with a default salt. Since every function in this contract calls `Immutables::init()`,
/// which verifies capsule data against salt, no functions can be tested until the TXE
/// supports custom salt deployment.
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress) {
    let mut env = TestEnvironment::new();
    let contract_address = env
        .deploy("@schnorr_initializerless_account_contract/SchnorrInitializerlessAccount")
        .without_initializer();

    (env, contract_address)
}
