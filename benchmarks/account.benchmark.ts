/**
 * Account Comparison Benchmark
 *
 * Compares gas cost and gate counts between:
 * - SchnorrConstantsAccount (initializerless, key committed in salt, capsule reads)
 * - Standard SchnorrAccount (initializer, key in SinglePrivateImmutable storage)
 *
 * Operations benchmarked for each account type:
 * 1. drip_to_private — Mint tokens to private balance
 * 2. drip_to_public  — Mint tokens to public balance
 * 3. transfer_private_to_private — Send private tokens to another address
 * 4. transfer_private_to_public  — Move own private tokens to public balance
 */

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { type ContractFunctionInteractionCallIntent } from "@aztec/aztec.js/authorization";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { TestWallet } from "@aztec/test-wallet/server";
import {
  Benchmark,
  type BenchmarkContext,
} from "@defi-wonderland/aztec-benchmark";
import type { NamedBenchmarkedInteraction } from "@defi-wonderland/aztec-benchmark/dist/types.js";

import { setupTestSuite } from "../src/ts/utils.js";
import {
  registerConstantsAccount,
  createSigningKeyCapsule,
  type DeployedSchnorrConstantsAccount,
} from "../src/ts/schnorr-constants-account/utils.js";
import { deploySchnorrAccount } from "../src/ts/schnorr-account/utils.js";
import { TokenContract } from "../src/artifacts/Token.js";
import { DripperContract } from "../src/artifacts/Dripper.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccountBenchmarkContext extends BenchmarkContext {
  store: AztecLMDBStoreV2;
  wallet: TestWallet;
  deployer: AztecAddress;
  token: TokenContract;
  dripper: DripperContract;
  constantsAccount: DeployedSchnorrConstantsAccount;
  standardAccountAddress: AztecAddress;
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

    // Deploy Dripper (faucet) and Token contracts
    const dripper = await DripperContract.deploy(wallet).send({
      from: deployer,
    });

    const token = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "BenchToken",
      "BT",
      18n,
      dripper.address,
      AztecAddress.ZERO,
    ).send({ from: deployer });

    // Deploy initializerless constants account
    const constantsAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });

    // Deploy standard schnorr account
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
    });
    const standardAccountAddress = standardAccount.contract.address;

    // Pre-fund both accounts with private tokens for transfer benchmarks
    const PREFUND_AMOUNT = 100_000n;

    const capsule = createSigningKeyCapsule(
      constantsAccount.address,
      constantsAccount.actualSalt,
      constantsAccount.signingPublicKey,
    );

    // Fund constants account
    await dripper.methods
      .drip_to_private(token.address, PREFUND_AMOUNT)
      .with({ capsules: [capsule] })
      .send({ from: constantsAccount.address });

    // Fund standard account
    await dripper.methods
      .drip_to_private(token.address, PREFUND_AMOUNT)
      .send({ from: standardAccountAddress });

    return {
      store,
      wallet,
      deployer,
      token,
      dripper,
      constantsAccount,
      standardAccountAddress,
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
      dripper,
      constantsAccount,
      standardAccountAddress,
    } = context;

    const DRIP_AMOUNT = 100n;
    const TRANSFER_AMOUNT = 10n;

    // Create capsule for constants account (needed for every tx it sends)
    const capsule = createSigningKeyCapsule(
      constantsAccount.address,
      constantsAccount.actualSalt,
      constantsAccount.signingPublicKey,
    );

    const methods: NamedBenchmarkedInteraction[] = [
      // --- Constants Account ---
      {
        interaction: {
          caller: constantsAccount.address,
          action: dripper
            .withWallet(wallet)
            .methods.drip_to_private(token.address, DRIP_AMOUNT)
            .with({ capsules: [capsule] }),
        },
        name: "Constants Account: drip_to_private",
      },
      {
        interaction: {
          caller: constantsAccount.address,
          action: dripper
            .withWallet(wallet)
            .methods.drip_to_public(token.address, DRIP_AMOUNT)
            .with({ capsules: [capsule] }),
        },
        name: "Constants Account: drip_to_public",
      },
      {
        interaction: {
          caller: constantsAccount.address,
          action: token
            .withWallet(wallet)
            .methods.transfer_private_to_private(
              constantsAccount.address,
              deployer,
              TRANSFER_AMOUNT,
              0n,
            )
            .with({ capsules: [capsule] }),
        },
        name: "Constants Account: transfer_private_to_private",
      },
      {
        interaction: {
          caller: constantsAccount.address,
          action: token
            .withWallet(wallet)
            .methods.transfer_private_to_public(
              constantsAccount.address,
              constantsAccount.address,
              TRANSFER_AMOUNT,
              0n,
            )
            .with({ capsules: [capsule] }),
        },
        name: "Constants Account: transfer_private_to_public",
      },

      // --- Standard Account ---
      {
        interaction: {
          caller: standardAccountAddress,
          action: dripper
            .withWallet(wallet)
            .methods.drip_to_private(token.address, DRIP_AMOUNT),
        },
        name: "Standard Account: drip_to_private",
      },
      {
        interaction: {
          caller: standardAccountAddress,
          action: dripper
            .withWallet(wallet)
            .methods.drip_to_public(token.address, DRIP_AMOUNT),
        },
        name: "Standard Account: drip_to_public",
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
    await context.store.delete();
    process.exit(0);
  }
}
