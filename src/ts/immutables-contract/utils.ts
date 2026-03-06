import { Fr } from "@aztec/aztec.js/fields";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import {
  ImmutablesContractContract,
  ImmutablesContractContractArtifact,
} from "../../artifacts/ImmutablesContract.js";
import * as generic from "../immutables/index.js";
import type { DeployWithImmutablesOptions } from "../immutables/index.js";

// Re-export from generic
export {
  IMMUTABLES_SLOT,
  createImmutablesCapsule,
  computeContractSalt,
  getImmutablesLayout,
  serializeFromLayout,
} from "../immutables/index.js";

/**
 * Immutables type matching the Noir struct:
 * ```noir
 * #[immutables]
 * pub struct Immutables {
 *     pub signing_key_x: Field,
 *     pub signing_key_y: Field,
 * }
 * ```
 */
export interface Immutables {
  signingKeyX: Fr;
  signingKeyY: Fr;
}

/**
 * Serializes Immutables to Fr[] using the artifact's `#[abi(immutables)]` layout.
 *
 * Maps TypeScript camelCase names to Noir snake_case field names and uses the
 * layout to determine serialization order and validate field completeness.
 */
export function serializeImmutables(immutables: Immutables): Fr[] {
  return generic.serializeFromLayout(ImmutablesContractContractArtifact, {
    signing_key_x: immutables.signingKeyX,
    signing_key_y: immutables.signingKeyY,
  });
}

/**
 * Result of deploying the immutables contract
 */
export interface DeployImmutablesContractResult {
  contract: ImmutablesContractContract;
  /**
   * The full capsule data: `[actualSalt, ...serializedImmutables]`.
   * Persist this for backup — needed to re-store immutables on a new PXE.
   */
  capsuleData: Fr[];
}

/**
 * Deploys the ImmutablesContract with the given immutables using the initializerless pattern.
 *
 * @param wallet - The wallet to deploy with
 * @param deployer - The account address that pays fees and sends the publish transaction
 * @param immutables - The immutables to commit to the contract address
 * @param options - Optional deployment options
 * @returns The deployed contract and capsuleData for backup/recovery
 */
export async function deployImmutablesContract(
  wallet: Wallet,
  deployer: AztecAddress,
  immutables: Immutables,
  options?: DeployWithImmutablesOptions,
): Promise<DeployImmutablesContractResult> {
  const result = await generic.deployWithImmutables(
    wallet,
    deployer,
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
    capsuleData: result.capsuleData,
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
 * @param wallet - The wallet to deploy with
 * @param deployer - The account address that pays fees and sends the publish transaction
 * @param immutables - The immutables to commit to the contract address
 * @param initialCounter - The initial counter value for storage
 * @returns The deployed contract and capsuleData for backup/recovery
 */
export async function deployMixedUsageContract(
  wallet: Wallet,
  deployer: AztecAddress,
  immutables: Immutables,
  initialCounter: bigint,
): Promise<DeployImmutablesContractResult> {
  const result = await generic.deployWithImmutables(
    wallet,
    deployer,
    ImmutablesContractContractArtifact,
    serializeImmutables(immutables),
    {
      initializer: "initialize",
      initializerArgs: [initialCounter],
      publishClass: true,
      publishInstance: true,
    },
  );

  const contract = ImmutablesContractContract.at(
    result.instance.address,
    wallet,
  );

  return {
    contract,
    capsuleData: result.capsuleData,
  };
}
