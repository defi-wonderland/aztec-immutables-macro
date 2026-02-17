import { Fr } from "@aztec/aztec.js/fields";
import type { Wallet } from "@aztec/aztec.js/wallet";
import {
  ImmutablesContractContract,
  ImmutablesContractContractArtifact,
} from "../../artifacts/ImmutablesContract.js";
import * as generic from "../immutables/utils.js";
import type { DeployWithImmutablesOptions } from "../immutables/utils.js";

// Re-export from generic
export {
  IMMUTABLES_SLOT,
  createImmutablesCapsule,
  computeContractSalt,
} from "../immutables/utils.js";

/**
 * Immutables type matching the Noir struct
 */
export interface Immutables {
  signingKeyX: Fr;
  signingKeyY: Fr;
}

/**
 * Serializes Immutables to Fr array (matches Noir serialization order)
 */
export function serializeImmutables(immutables: Immutables): Fr[] {
  return [immutables.signingKeyX, immutables.signingKeyY];
}

/**
 * Result of deploying the immutables contract
 */
export interface DeployImmutablesContractResult {
  contract: ImmutablesContractContract;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
  /** Whether the contract instance was published on-chain */
  isPublished: boolean;
}

/**
 * Deploys the ImmutablesContract with the given immutables using the initializerless pattern.
 *
 * This handles the initializerless deployment pattern:
 * 1. Generates random actual_salt
 * 2. Computes salt = poseidon2Hash([actual_salt, ...serialized_immutables])
 * 3. Creates contract instance with this salt
 * 4. Registers and publishes the contract
 * 5. Sends capsule containing [actual_salt, ...serialized_immutables]
 *
 * @param wallet - The wallet to deploy with
 * @param immutables - The immutables to commit to the contract address
 * @param options - Optional deployment options
 * @returns The deployed contract and actual_salt for capsule creation
 */
export async function deployImmutablesContract(
  wallet: Wallet,
  immutables: Immutables,
  options?: DeployWithImmutablesOptions,
): Promise<DeployImmutablesContractResult> {
  const result = await generic.deployWithImmutables(
    wallet,
    ImmutablesContractContractArtifact,
    serializeImmutables(immutables),
    options,
  );

  const contract = ImmutablesContractContract.at(
    result.instance.address,
    wallet,
  );

  return {
    contract,
    actualSalt: result.actualSalt,
    isPublished: result.isPublished,
  };
}

/**
 * Deploys the ImmutablesContract using the standard initializer pattern.
 *
 * This is for mixed usage scenarios where:
 * - The contract has both immutables AND mutable storage
 * - The initializer sets up storage
 * - Immutables are passed via capsule
 *
 * Note: This deployment computes initialization_hash from the initializer args only,
 * NOT including the immutables. This means immutables verification will fail.
 * For production mixed usage, a custom deployment that includes
 * both initializer args AND immutables in the salt computation would be needed.
 *
 * @param wallet - The wallet to deploy with
 * @param immutables - The immutables to pass via capsule
 * @param initialCounter - The initial counter value for storage
 * @returns The deployed contract and actual_salt for capsule creation
 */
export async function deployMixedUsageContract(
  wallet: Wallet,
  immutables: Immutables,
  initialCounter: bigint,
): Promise<DeployImmutablesContractResult> {
  const deployerAddress = (await wallet.getAccounts())[0]!.item;
  const actualSalt = Fr.random();

  // Deploy using standard method with initializer
  const deployMethod = ImmutablesContractContract.deploy(
    wallet,
    initialCounter,
  );

  // Get the deployment address before sending to create capsule
  const instance = await deployMethod.getInstance();
  const capsule = generic.createImmutablesCapsule(
    instance.address,
    actualSalt,
    serializeImmutables(immutables),
  );

  // Deploy with capsule attached
  const contract = (await deployMethod
    .with({ capsules: [capsule] })
    .send({ from: deployerAddress })) as ImmutablesContractContract;

  return { contract, actualSalt, isPublished: true };
}
