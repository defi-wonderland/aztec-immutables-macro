/**
 * E2E Tests for SchnorrConstantsAccount
 *
 * These tests verify the initializerless constants pattern for an account contract
 * that stores a signing public key committed via salt.
 *
 * Unlike Noir TXE tests, these E2E tests have full control over deployment and
 * properly verify the constants pattern works end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestWallet } from "@aztec/test-wallet/server";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import {
  createSigningKeyCapsule,
  computeContractSalt,
  computeSchnorrAccountAddress,
  type SigningPublicKey,
} from "./schnorr-constants-account/utils.js";
import { registerConstantsAccount } from "./schnorr-constants-account/wallet-integration.js";
import { setupTestSuite } from "./utils.js";

describe("SchnorrConstantsAccount - Initializerless Constants Pattern", () => {
  let store: AztecLMDBStoreV2;
  let wallet: TestWallet;
  let alice: AztecAddress;

  beforeAll(async () => {
    ({
      store,
      wallet,
      accounts: [alice],
    } = await setupTestSuite("schnorr-constants"));
  });

  afterAll(async () => {
    await store.delete();
  });

  it("should deploy account with signing key and read it back", async () => {
    // Deploy the account contract
    const { contract, actualSalt, signingPublicKey } =
      await registerConstantsAccount(wallet);

    // Verify contract was deployed
    expect(contract.address).toBeDefined();
    expect(contract.address.toString()).not.toBe(AztecAddress.ZERO.toString());

    // Create capsule for the call (capsules must be passed with each call that reads them)
    const capsule = createSigningKeyCapsule(
      contract.address,
      actualSalt,
      signingPublicKey,
    );

    // Call the private function that reads the signing key
    const result = await contract.methods
      .get_signing_public_key()
      .with({ capsules: [capsule] })
      .simulate({
        from: alice,
      });

    // Verify the returned values match what we deployed with
    expect(result[0]).toEqual(signingPublicKey.x.toBigInt());
    expect(result[1]).toEqual(signingPublicKey.y.toBigInt());
  });

  it("should deploy with different secret keys and get different addresses", async () => {
    // Deploy two accounts with different secret keys
    const account1 = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });
    const account2 = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });

    // Different secrets should produce different addresses
    expect(account1.address.toString()).not.toBe(account2.address.toString());

    // Verify each contract returns its correct key
    const capsule1 = createSigningKeyCapsule(
      account1.address,
      account1.actualSalt,
      account1.signingPublicKey,
    );
    const result1 = await account1.contract.methods
      .get_signing_public_key()
      .with({ capsules: [capsule1] })
      .simulate({ from: alice });

    expect(result1[0]).toEqual(account1.signingPublicKey.x.toBigInt());
    expect(result1[1]).toEqual(account1.signingPublicKey.y.toBigInt());

    const capsule2 = createSigningKeyCapsule(
      account2.address,
      account2.actualSalt,
      account2.signingPublicKey,
    );
    const result2 = await account2.contract.methods
      .get_signing_public_key()
      .with({ capsules: [capsule2] })
      .simulate({ from: alice });

    expect(result2[0]).toEqual(account2.signingPublicKey.x.toBigInt());
    expect(result2[1]).toEqual(account2.signingPublicKey.y.toBigInt());
  });

  it("should produce different addresses for different signing keys", async () => {
    const signingKey1: SigningPublicKey = {
      x: new Fr(111n),
      y: new Fr(222n),
    };
    const signingKey2: SigningPublicKey = {
      x: new Fr(333n),
      y: new Fr(444n),
    };

    // Compute addresses with fixed actualSalt for determinism
    const fixedActualSalt = new Fr(12345n);

    const result1 = await computeSchnorrAccountAddress(signingKey1, {
      actualSalt: fixedActualSalt,
    });
    const result2 = await computeSchnorrAccountAddress(signingKey2, {
      actualSalt: fixedActualSalt,
    });

    // Different signing keys should produce different addresses
    expect(result1.address.toString()).not.toBe(result2.address.toString());
  });

  it("should produce different addresses for different actualSalt", async () => {
    const signingKey: SigningPublicKey = {
      x: new Fr(111n),
      y: new Fr(222n),
    };

    // Compute addresses with same signing key but different actualSalt
    const fixedActualSalt1 = new Fr(12345n);
    const fixedActualSalt2 = new Fr(54321n);

    const result1 = await computeSchnorrAccountAddress(signingKey, {
      actualSalt: fixedActualSalt1,
    });
    const result2 = await computeSchnorrAccountAddress(signingKey, {
      actualSalt: fixedActualSalt2,
    });

    // Different actualSalt should produce different addresses
    expect(result1.address.toString()).not.toBe(result2.address.toString());
  });

  it("should produce consistent addresses for same signing key and actualSalt", async () => {
    const signingKey: SigningPublicKey = {
      x: new Fr(999n),
      y: new Fr(888n),
    };
    const fixedActualSalt = new Fr(54321n);

    const result1 = await computeSchnorrAccountAddress(signingKey, {
      actualSalt: fixedActualSalt,
    });
    const result2 = await computeSchnorrAccountAddress(signingKey, {
      actualSalt: fixedActualSalt,
    });

    // Same key and actualSalt should produce same address
    expect(result1.address.toString()).toBe(result2.address.toString());
  });

  it("should compute correct contract salt", async () => {
    const signingKey: SigningPublicKey = {
      x: new Fr(1n),
      y: new Fr(2n),
    };
    const actualSalt = new Fr(12345n);

    const salt = await computeContractSalt(actualSalt, signingKey);

    // Salt should be non-zero
    expect(salt.toBigInt()).not.toBe(0n);

    // Same inputs should produce same salt
    const salt2 = await computeContractSalt(actualSalt, signingKey);
    expect(salt.toBigInt()).toBe(salt2.toBigInt());

    // Different key should produce different salt
    const differentKey: SigningPublicKey = {
      x: new Fr(3n),
      y: new Fr(4n),
    };
    const differentSalt = await computeContractSalt(actualSalt, differentKey);
    expect(salt.toBigInt()).not.toBe(differentSalt.toBigInt());

    // Different actualSalt should produce different salt
    const differentActualSalt = new Fr(54321n);
    const saltWithDifferentActual = await computeContractSalt(
      differentActualSalt,
      signingKey,
    );
    expect(salt.toBigInt()).not.toBe(saltWithDifferentActual.toBigInt());
  });

  it("should fail with wrong capsule data", async () => {
    // Deploy account
    const { contract, actualSalt, signingPublicKey } =
      await registerConstantsAccount(wallet);

    // Try to call with a different (wrong) signing key in capsule
    const wrongKey: SigningPublicKey = {
      x: new Fr(signingPublicKey.x.toBigInt() + 1n),
      y: new Fr(signingPublicKey.y.toBigInt() + 1n),
    };
    const wrongCapsule = createSigningKeyCapsule(
      contract.address,
      actualSalt,
      wrongKey,
    );

    // This should fail because the capsule data doesn't match salt
    await expect(
      contract.methods
        .get_signing_public_key()
        .with({ capsules: [wrongCapsule] })
        .simulate({ from: alice }),
    ).rejects.toThrow("Constants do not match contract salt");
  });

  it("should deploy multiple accounts with different keys", async () => {
    const deployments = await Promise.all([
      registerConstantsAccount(wallet, { secretKey: Fr.random() }),
      registerConstantsAccount(wallet, { secretKey: Fr.random() }),
      registerConstantsAccount(wallet, { secretKey: Fr.random() }),
    ]);

    // Verify all addresses are unique
    const addresses = deployments.map((d) => d.address.toString());
    const uniqueAddresses = new Set(addresses);
    expect(uniqueAddresses.size).toBe(deployments.length);

    // Verify each contract returns its correct key
    for (const { contract, actualSalt, signingPublicKey } of deployments) {
      const capsule = createSigningKeyCapsule(
        contract.address,
        actualSalt,
        signingPublicKey,
      );
      const result = await contract.methods
        .get_signing_public_key()
        .with({ capsules: [capsule] })
        .simulate({ from: alice });

      expect(result[0]).toEqual(signingPublicKey.x.toBigInt());
      expect(result[1]).toEqual(signingPublicKey.y.toBigInt());
    }
  });
});
