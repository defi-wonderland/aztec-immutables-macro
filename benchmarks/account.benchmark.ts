/**
 * Account Comparison Benchmark
 *
 * Compares gas cost and gate counts between:
 * - Immutables Account (initializerless, key committed in salt, persistent CapsuleStore)
 * - Standard SchnorrAccount (initializer, key in SinglePrivateImmutable storage)
 *
 * Operations benchmarked for each account type:
 * 1. transfer_private_to_private — Send private tokens to another address
 * 2. transfer_private_to_public  — Move own private tokens to public balance
 *
 * These are the operations where the account entrypoint runs and the
 * key-loading difference (CapsuleStore vs SinglePrivateImmutable) matters.
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { type ContractFunctionInteractionCallIntent } from "@aztec/aztec.js/authorization";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import { TestWallet } from "@aztec/test-wallet/server";
import {
  Benchmark,
  type BenchmarkContext,
} from "@defi-wonderland/aztec-benchmark";
import type { NamedBenchmarkedInteraction } from "@defi-wonderland/aztec-benchmark/dist/types.js";

import { setupTestSuite } from "../src/ts/utils.js";
import {
  deploySchnorrInitializerlessAccount,
  type DeploySchnorrInitializerlessAccountResult,
} from "../src/ts/schnorr-initializerless-account/index.js";
import { deploySchnorrAccount } from "../src/ts/schnorr-account/utils.js";
import { TokenContract } from "../src/artifacts/Token.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccountBenchmarkContext extends BenchmarkContext {
  store: AztecLMDBStoreV2;
  wallet: TestWallet;
  deployer: AztecAddress;
  token: TokenContract;
  immutablesAccount: DeploySchnorrInitializerlessAccountResult;
  standardAccountAddress: AztecAddress;
  sponsoredPaymentMethod: SponsoredFeePaymentMethod;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

export default class AccountComparisonBenchmark extends Benchmark {
  async setup(): Promise<AccountBenchmarkContext> {
    const { store, wallet, accounts } = await setupTestSuite(
      "bench-account",
      true,
    );
    const [deployer] = accounts;

    // Register the canonical SponsoredFPC for fee sponsorship.
    const sponsoredFPCInstance =
      await getContractInstanceFromInstantiationParams(
        SponsoredFPCContract.artifact,
        { salt: new Fr(0n) },
      );
    await wallet.registerContract(
      sponsoredFPCInstance,
      SponsoredFPCContract.artifact,
    );
    const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(
      sponsoredFPCInstance.address,
    );

    // Deploy Token contract with deployer as minter
    const token = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "BenchToken",
      "BT",
      18n,
      deployer,
      AztecAddress.ZERO,
    ).send({ from: deployer });

    // Deploy initializerless immutables account
    const immutablesAccount = await deploySchnorrInitializerlessAccount(
      wallet,
      { secretKey: Fr.random() },
    );
    // Register account with TestWallet for signing
    // @ts-ignore — TestWallet-specific: register account for signing
    wallet.accounts?.set(
      immutablesAccount.address.toString(),
      immutablesAccount.account,
    );

    // Deploy standard schnorr account
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
    });
    const standardAccountAddress = standardAccount.contract.address;

    // Pre-fund both accounts with private tokens for transfer benchmarks
    const PREFUND_AMOUNT = 100_000n;

    await token.methods
      .mint_to_private(immutablesAccount.address, PREFUND_AMOUNT)
      .send({ from: deployer });

    await token.methods
      .mint_to_private(standardAccountAddress, PREFUND_AMOUNT)
      .send({ from: deployer });

    return {
      store,
      wallet,
      deployer,
      token,
      immutablesAccount,
      standardAccountAddress,
      sponsoredPaymentMethod,
      feePaymentMethod: sponsoredPaymentMethod,
    };
  }

  getMethods(
    context: AccountBenchmarkContext,
  ): Array<
    NamedBenchmarkedInteraction | ContractFunctionInteractionCallIntent
  > {
    const {
      wallet,
      deployer,
      token,
      immutablesAccount,
      standardAccountAddress,
    } = context;

    const TRANSFER_AMOUNT = 10n;

    const methods: NamedBenchmarkedInteraction[] = [
      // --- Immutables Account ---
      {
        interaction: {
          caller: immutablesAccount.address,
          action: token
            .withWallet(wallet)
            .methods.transfer_private_to_private(
              immutablesAccount.address,
              deployer,
              TRANSFER_AMOUNT,
              0n,
            ),
        },
        name: "Immutables Account: transfer_private_to_private",
      },
      {
        interaction: {
          caller: immutablesAccount.address,
          action: token
            .withWallet(wallet)
            .methods.transfer_private_to_public(
              immutablesAccount.address,
              immutablesAccount.address,
              TRANSFER_AMOUNT,
              0n,
            ),
        },
        name: "Immutables Account: transfer_private_to_public",
      },

      // --- Standard Account ---
      {
        interaction: {
          caller: standardAccountAddress,
          action: token
            .withWallet(wallet)
            .methods.transfer_private_to_private(
              standardAccountAddress,
              deployer,
              TRANSFER_AMOUNT,
              0n,
            ),
        },
        name: "Standard Account: transfer_private_to_private",
      },
      {
        interaction: {
          caller: standardAccountAddress,
          action: token
            .withWallet(wallet)
            .methods.transfer_private_to_public(
              standardAccountAddress,
              standardAccountAddress,
              TRANSFER_AMOUNT,
              0n,
            ),
        },
        name: "Standard Account: transfer_private_to_public",
      },
    ];

    return methods;
  }

  async teardown(context: AccountBenchmarkContext): Promise<void> {
    await context.store.delete();
    process.exit(0);
  }
}
