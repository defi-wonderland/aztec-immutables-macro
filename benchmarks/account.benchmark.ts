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
import type { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { Fr } from "@aztec/aztec.js/fields";
import {
  Benchmark,
  type BenchmarkContext,
} from "@defi-wonderland/aztec-benchmark";
import type { NamedBenchmarkedInteraction } from "@defi-wonderland/aztec-benchmark/dist/types.js";

import { setupTestSuite, CustomEmbeddedWallet } from "../src/ts/utils.js";
import {
  deploySchnorrInitializerlessAccount,
  type DeploySchnorrInitializerlessAccountResult,
} from "../src/ts/schnorr-initializerless-account/index.js";
import { deploySchnorrAccount } from "../src/ts/schnorr-account/utils.js";
import { TokenContract } from "@defi-wonderland/aztec-standards/artifacts/src/artifacts/Token.js";
import type { ContractFunctionInteraction } from "@aztec/aztec.js/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccountBenchmarkContext extends BenchmarkContext {
  cleanup: () => Promise<void>;
  wallet: CustomEmbeddedWallet;
  deployer: AztecAddress;
  token: TokenContract;
  immutablesAccount: DeploySchnorrInitializerlessAccountResult;
  standardAccountAddress: AztecAddress;
  standardAccountInitialize: ContractFunctionInteraction;
  sponsoredPaymentMethod: SponsoredFeePaymentMethod;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

export default class AccountComparisonBenchmark extends Benchmark {
  async setup(): Promise<AccountBenchmarkContext> {
    const { cleanup, wallet, accounts, sponsoredPaymentMethod } =
      await setupTestSuite(true);
    const [deployer] = accounts;

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
    // Register account with wallet for signing
    wallet.registerCustomAccount(
      immutablesAccount.address,
      immutablesAccount.account,
    );

    // Deploy standard schnorr account (needs sponsored fee for deployment)
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
      fee: { paymentMethod: sponsoredPaymentMethod },
    });
    const standardAccountAddress = standardAccount.contract.address;

    // Prepare a fresh standard account deploy+initialize for benchmarking.
    // This measures the initialization cost that initializerless accounts avoid.
    // We use createAccount() to register keys with PXE, then get the deploy method
    // without sending — the profiler will simulate/prove/send it.
    const benchAccountManager = await wallet.createSchnorrAccount(
      Fr.random(),
      Fr.random(),
    );
    const standardAccountInitialize =
      (await benchAccountManager.getDeployMethod()) as unknown as ContractFunctionInteraction;

    // Pre-fund both accounts with private tokens for transfer benchmarks
    const PREFUND_AMOUNT = 100_000n;

    await token.methods
      .mint_to_private(immutablesAccount.address, PREFUND_AMOUNT)
      .send({ from: deployer });

    await token.methods
      .mint_to_private(standardAccountAddress, PREFUND_AMOUNT)
      .send({ from: deployer });

    return {
      cleanup,
      wallet,
      deployer,
      token,
      immutablesAccount,
      standardAccountAddress,
      standardAccountInitialize,
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
      standardAccountInitialize,
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
          caller: deployer,
          action: standardAccountInitialize,
        },
        name: "Standard Account: deploy + initialize",
      },
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
    await context.cleanup();
  }
}
