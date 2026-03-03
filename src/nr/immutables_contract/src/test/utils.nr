use crate::ImmutablesContract;
use aztec::protocol::address::AztecAddress;
use aztec::test::helpers::test_environment::TestEnvironment;

/// Deploys the ImmutablesContract and returns the environment and contract address.
///
/// Note: The TXE does not support custom salt values, so the contract is deployed
/// with a default salt. This means `Immutables::init()` cannot verify the salt
/// and will fail. See individual test files for details.
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress) {
    let mut env = TestEnvironment::new();
    let contract_address =
        env.deploy("@immutables_contract/ImmutablesContract").without_initializer();

    (env, contract_address)
}

/// Deploys the ImmutablesContract with the initializer for mixed usage tests.
pub unconstrained fn setup_with_initializer(
    initial_counter: u64,
) -> (TestEnvironment, AztecAddress) {
    let mut env = TestEnvironment::new();
    let owner = env.create_light_account();
    let contract_address = env
        .deploy("@immutables_contract/ImmutablesContract")
        .with_public_initializer(owner, ImmutablesContract::interface().initialize(initial_counter))
        ;

    (env, contract_address)
}
