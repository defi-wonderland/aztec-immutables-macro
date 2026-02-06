import { Fr } from "@aztec/aztec.js/fields";
import type { Wallet } from "@aztec/aztec.js/wallet";
import {
  ConstantsContractContract,
  ConstantsContractContractArtifact,
} from "../../artifacts/ConstantsContract.js";
import * as generic from "../initializerless/utils.js";
import type { DeployWithConstantsOptions } from "../initializerless/utils.js";

// Re-export from generic
export {
  CONSTANTS_SLOT,
  createConstantsCapsule,
  computeContractSalt,
} from "../initializerless/utils.js";

/**
 * Constants type matching the Noir struct
 */
export interface Constants {
  signingKeyX: Fr;
  signingKeyY: Fr;
}

/**
 * Serializes Constants to Fr array (matches Noir serialization order)
 */
export function serializeConstants(constants: Constants): Fr[] {
  return [constants.signingKeyX, constants.signingKeyY];
}

/**
 * Result of deploying the constants contract
 */
export interface DeployConstantsContractResult {
  contract: ConstantsContractContract;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
  /** Whether the contract instance was published on-chain */
  isPublished: boolean;
}

/**
 * Deploys the ConstantsContract with the given constants using the initializerless pattern.
 *
 * This handles the initializerless deployment pattern:
 * 1. Generates random actual_salt
 * 2. Computes salt = poseidon2Hash([actual_salt, ...serialized_constants])
 * 3. Creates contract instance with this salt
 * 4. Registers and publishes the contract
 * 5. Sends capsule containing [actual_salt, ...serialized_constants]
 *
 * @param wallet - The wallet to deploy with
 * @param constants - The constants to commit to the contract address
 * @param options - Optional deployment options
 * @returns The deployed contract and actual_salt for capsule creation
 */
export async function deployConstantsContract(
  wallet: Wallet,
  constants: Constants,
  options?: DeployWithConstantsOptions,
): Promise<DeployConstantsContractResult> {
  const result = await generic.deployWithConstants(
    wallet,
    ConstantsContractContractArtifact,
    serializeConstants(constants),
    options,
  );

  const contract = ConstantsContractContract.at(
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
 * Deploys the ConstantsContract using the standard initializer pattern.
 *
 * This is for mixed usage scenarios where:
 * - The contract has both constants AND mutable storage
 * - The initializer sets up storage
 * - Constants are passed via capsule
 *
 * Note: This deployment computes initialization_hash from the initializer args only,
 * NOT including the constants. This means constants verification will fail.
 * For production mixed usage, a custom deployment that includes
 * both initializer args AND constants in the salt computation would be needed.
 *
 * @param wallet - The wallet to deploy with
 * @param constants - The constants to pass via capsule
 * @param initialCounter - The initial counter value for storage
 * @returns The deployed contract and actual_salt for capsule creation
 */
export async function deployMixedUsageContract(
  wallet: Wallet,
  constants: Constants,
  initialCounter: bigint,
): Promise<DeployConstantsContractResult> {
  const deployerAddress = (await wallet.getAccounts())[0]!.item;
  const actualSalt = Fr.random();

  // Deploy using standard method with initializer
  const deployMethod = ConstantsContractContract.deploy(wallet, initialCounter);

  // Get the deployment address before sending to create capsule
  const instance = await deployMethod.getInstance();
  const capsule = generic.createConstantsCapsule(
    instance.address,
    actualSalt,
    serializeConstants(constants),
  );

  // Deploy with capsule attached
  const contract = (await deployMethod
    .with({ capsules: [capsule] })
    .send({ from: deployerAddress })) as ConstantsContractContract;

  return { contract, actualSalt, isPublished: true };
}
