import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { rmSync } from "fs";
import { join } from "path";

import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import type { Account } from "@aztec/aztec.js/account";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";

const { NODE_URL = "http://localhost:8080" } = process.env;

/**
 * EmbeddedWallet subclass that supports custom account types.
 *
 * EmbeddedWallet only knows how to sign for built-in account types (schnorr,
 * ecdsasecp256k1, ecdsasecp256r1) stored in its WalletDB. Custom accounts like
 * SchnorrInitializerlessAccount aren't registered through that path.
 *
 * This subclass overrides `getAccountFromAddress` to check a custom accounts
 * map first, and also registers custom accounts in the WalletDB as 'schnorr'
 * type so `simulateViaEntrypoint` can find them when building transaction
 * requests (it calls `walletDB.retrieveAccount` to get the account type for
 * stub account creation — only the type is needed there).
 *
 * Since `NodeEmbeddedWallet.create()` uses `new this(...)`, calling
 * `CustomEmbeddedWallet.create()` returns a `CustomEmbeddedWallet` instance.
 */
export class CustomEmbeddedWallet extends EmbeddedWallet {
  private customAccounts = new Map<string, Account>();

  /**
   * Register a custom Schnorr-compatible account for signing.
   *
   * Stores the account in both the local custom-accounts map (for auth witness
   * creation via `getAccountFromAddress`) and in the WalletDB as type 'schnorr'
   * (so `simulateViaEntrypoint` can find the account type for stub creation).
   *
   * Dummy values are used for secretKey/salt/signingKey in the WalletDB entry
   * because only `type` is read back from it during stub-based simulation.
   */
  async registerCustomAccount(
    address: AztecAddress,
    account: Account,
  ): Promise<void> {
    this.customAccounts.set(address.toString(), account);
    // Register in walletDB so simulateViaEntrypoint can look up the account type.
    // Only `type` is used from this entry; secretKey/salt/signingKey are placeholders.
    await this.walletDB.storeAccount(address, {
      type: "schnorr",
      secretKey: Fr.ZERO,
      salt: Fr.ZERO,
      signingKey: Buffer.alloc(32),
      alias: undefined,
    });
  }

  protected override async getAccountFromAddress(
    address: AztecAddress,
  ): Promise<Account> {
    const custom = this.customAccounts.get(address.toString());
    if (custom) return custom;
    return super.getAccountFromAddress(address);
  }
}

/**
 * Setup the node, wallet and accounts for tests.
 * @param proverEnabled - optional - Whether to enable the prover.
 * @returns The wallet, accounts and a cleanup function. Call `cleanup()` in afterAll to teardown.
 */
export async function setupTestSuite(proverEnabled: boolean = false) {
  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);

  const dataDirectory = join(
    tmpdir(),
    `immutables-macro-${randomBytes(8).toString("hex")}`,
  );

  const wallet: CustomEmbeddedWallet = await CustomEmbeddedWallet.create(node, {
    pxe: { dataDirectory, proverEnabled },
  });

  const accounts: AztecAddress[] =
    await registerInitialLocalNetworkAccountsInWallet(wallet);

  const cleanup = async () => {
    await wallet.stop();
    try {
      rmSync(dataDirectory, { recursive: true, force: true });
    } catch {}
  };

  // Register the canonical SponsoredFPC for fee sponsorship.
  // Needed for txs sent by accounts without fee juice (e.g., custom accounts,
  // AztecAddress.ZERO account deployments). NOT needed for publications from
  // the pre-funded deployer.
  const sponsoredFPCAddress = await registerSponsoredFPC(wallet);
  const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(
    sponsoredFPCAddress,
  );

  return {
    node,
    wallet,
    accounts,
    sponsoredPaymentMethod,
    cleanup,
  };
}

/**
 * Register the canonical SponsoredFPC contract and return its address.
 * The SponsoredFPC is deployed at a well-known address using salt = 0.
 */
async function registerSponsoredFPC(
  wallet: CustomEmbeddedWallet,
): Promise<AztecAddress> {
  const instance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(0n) },
  );
  await wallet.registerContract(instance, SponsoredFPCContract.artifact);
  return instance.address;
}
