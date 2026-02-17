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
 * Deploys the ImmutablesContract with both immutables and an initializer.
 *
 * This is for mixed usage scenarios where:
 * - The contract has both immutables AND mutable storage
 * - The initializer sets up storage (counter)
 * - Immutables are committed via the salt derivation
 *
 * Uses `deployWithImmutables` with initializer options so the contract instance
 * includes the correct initializationHash while still deriving the salt from immutables.
 *
 * @param wallet - The wallet to deploy with
 * @param immutables - The immutables to commit to the contract address
 * @param initialCounter - The initial counter value for storage
 * @returns The deployed contract and actual_salt for capsule creation
 */
export async function deployMixedUsageContract(
  wallet: Wallet,
  immutables: Immutables,
  initialCounter: bigint,
): Promise<DeployImmutablesContractResult> {
  const result = await generic.deployWithImmutables(
    wallet,
    ImmutablesContractContractArtifact,
    serializeImmutables(immutables),
    {
      initializer: "initialize",
      initializerArgs: [initialCounter],
    },
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
