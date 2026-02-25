import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import type { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import {
  deployImmutablesContract,
  deployMixedUsageContract,
  serializeImmutables,
  createImmutablesCapsule,
  type Immutables,
  computeContractSalt,
} from "./immutables-contract/utils.js";
import { setupTestSuite } from "./utils.js";

const IMMUTABLES_1: Immutables = {
  signingKeyX: new Fr(111n),
  signingKeyY: new Fr(222n),
};
const IMMUTABLES_2: Immutables = {
  signingKeyX: new Fr(333n),
  signingKeyY: new Fr(444n),
};
const ACTUAL_SALT_1 = new Fr(12345n);
const ACTUAL_SALT_2 = new Fr(54321n);
const INITIAL_COUNTER = 42n;

describe("Immutables Contract - Initializerless Pattern", () => {
  let cleanup: () => Promise<void>;
  let wallet: EmbeddedWallet;
  let alice: AztecAddress;
  let sponsoredPaymentMethod: SponsoredFeePaymentMethod;

  beforeAll(async () => {
    ({
      cleanup,
      wallet,
      accounts: [alice],
      sponsoredPaymentMethod,
    } = await setupTestSuite());
  });

  afterAll(async () => {
    await cleanup();
  });

  // Pure computation tests (no deployment, no published/unpublished distinction)
  it("should produce different addresses for different actualSalt", async () => {
    // Deploy two contracts with same immutables but different actualSalt
    const { contract: contract1 } = await deployImmutablesContract(
      wallet,
      IMMUTABLES_1,
      { actualSalt: ACTUAL_SALT_1 },
    );
    const { contract: contract2 } = await deployImmutablesContract(
      wallet,
      IMMUTABLES_1,
      { actualSalt: ACTUAL_SALT_2 },
    );

    // Different actualSalt should produce different addresses
    expect(contract1.address.toString()).not.toBe(contract2.address.toString());
  });

  it("should compute correct contract salt", async () => {
    const actualSalt = new Fr(12345n);
    const salt = computeContractSalt(
      ACTUAL_SALT_1,
      serializeImmutables(IMMUTABLES_1),
    );

    // Salt should be non-zero
    expect(salt.toBigInt()).not.toBe(0n);

    // Same inputs should produce same salt
    const salt2 = computeContractSalt(
      ACTUAL_SALT_1,
      serializeImmutables(IMMUTABLES_1),
    );
    expect(salt.toBigInt()).toBe(salt2.toBigInt());

    // Different immutables should produce different salt
    const differentSalt = computeContractSalt(
      ACTUAL_SALT_1,
      serializeImmutables(IMMUTABLES_2),
    );
    expect(salt.toBigInt()).not.toBe(differentSalt.toBigInt());

    // Different actualSalt should produce different salt
    const saltWithDifferentActual = computeContractSalt(
      ACTUAL_SALT_2,
      serializeImmutables(IMMUTABLES_1),
    );
    expect(salt.toBigInt()).not.toBe(saltWithDifferentActual.toBigInt());
  });

  // Published deployment tests
  describe("Published", () => {
    it("should deploy contract with immutables and read them back", async () => {
      const { contract } = await deployImmutablesContract(
        wallet,
        IMMUTABLES_1,
        {
          publishClass: true,
          publishInstance: true,
          fee: { paymentMethod: sponsoredPaymentMethod },
        },
      );

      expect(contract.address).toBeDefined();
      expect(contract.address.toString()).not.toBe(
        AztecAddress.ZERO.toString(),
      );

      // Verify instance IS published on-chain
      const metadata = await wallet.getContractMetadata(contract.address);
      expect(metadata.isContractPublished).toBe(true);

      // Immutables loaded from persistent store (store_immutables called during deployment)
      const result = await contract.methods.get_signing_key().simulate({
        from: alice,
      });

      expect(result[0]).toEqual(IMMUTABLES_1.signingKeyX.toBigInt());
      expect(result[1]).toEqual(IMMUTABLES_1.signingKeyY.toBigInt());
    });

    it("should fail with wrong capsule data", async () => {
      const { contract, capsuleData } = await deployImmutablesContract(
        wallet,
        IMMUTABLES_1,
      );

      const wrongCapsule = createImmutablesCapsule(
        contract.address,
        capsuleData[0], // actualSalt
        serializeImmutables(IMMUTABLES_2),
      );

      await expect(
        contract.methods
          .get_signing_key()
          .with({ capsules: [wrongCapsule] })
          .simulate({ from: alice }),
      ).rejects.toThrow("Immutables do not match contract salt");
    });
  });

  it("should reject store_immutables with wrong data", async () => {
    const { contract, capsuleData } = await deployImmutablesContract(
      wallet,
      IMMUTABLES_1,
    );

    // Try to store wrong immutables (IMMUTABLES_2 instead of IMMUTABLES_1)
    // The Noir store() function validates poseidon2_hash(capsule_data) == instance.salt
    const wrongCapsuleData = [
      capsuleData[0],
      ...serializeImmutables(IMMUTABLES_2),
    ];

    await expect(
      contract.methods
        .store_immutables(wrongCapsuleData)
        .simulate({ from: alice }),
    ).rejects.toThrow(
      "Immutables data does not match contract salt, refusing to store",
    );
  });

  it("should allow re-storing correct immutables (PXE recovery)", async () => {
    const { contract, capsuleData } = await deployImmutablesContract(
      wallet,
      IMMUTABLES_1,
    );

    // Verify immutables are readable (stored during deployment)
    const result1 = await contract.methods
      .get_signing_key()
      .simulate({ from: alice });
    expect(result1[0]).toEqual(IMMUTABLES_1.signingKeyX.toBigInt());
    expect(result1[1]).toEqual(IMMUTABLES_1.signingKeyY.toBigInt());

    // Re-store immutables (simulating PXE recovery after data loss)
    await contract.methods
      .store_immutables(capsuleData)
      .simulate({ from: alice });

    // Verify immutables are still readable after re-store
    const result2 = await contract.methods
      .get_signing_key()
      .simulate({ from: alice });
    expect(result2[0]).toEqual(IMMUTABLES_1.signingKeyX.toBigInt());
    expect(result2[1]).toEqual(IMMUTABLES_1.signingKeyY.toBigInt());
  });

  it("should read immutables from PXE store without manual capsule", async () => {
    const { contract } = await deployImmutablesContract(wallet, IMMUTABLES_1);

    // Read immutables WITHOUT a transient capsule -- data comes from persistent store
    // (store_immutables is called automatically during deployment)
    const result = await contract.methods
      .get_signing_key()
      .simulate({ from: alice });

    expect(result[0]).toEqual(IMMUTABLES_1.signingKeyX.toBigInt());
    expect(result[1]).toEqual(IMMUTABLES_1.signingKeyY.toBigInt());
  });

  // Unpublished (PXE-only) deployment tests
  describe("Unpublished (PXE-only)", () => {
    it("should deploy unpublished contract and read immutables back", async () => {
      const { contract } = await deployImmutablesContract(wallet, IMMUTABLES_1);

      expect(contract.address).toBeDefined();
      expect(contract.address.toString()).not.toBe(
        AztecAddress.ZERO.toString(),
      );

      // Verify instance is NOT published on-chain
      const metadata = await wallet.getContractMetadata(contract.address);
      expect(metadata.isContractPublished).toBe(false);

      // Immutables loaded from persistent store (store_immutables called during deployment)
      const result = await contract.methods.get_signing_key().simulate({
        from: alice,
      });

      expect(result[0]).toEqual(IMMUTABLES_1.signingKeyX.toBigInt());
      expect(result[1]).toEqual(IMMUTABLES_1.signingKeyY.toBigInt());
    });
  });
});

describe("Immutables Contract - Mixed Usage (Immutables + Storage)", () => {
  let cleanup: () => Promise<void>;
  let wallet: EmbeddedWallet;
  let alice: AztecAddress;
  let sponsoredPaymentMethod: SponsoredFeePaymentMethod;

  beforeAll(async () => {
    ({
      cleanup,
      wallet,
      accounts: [alice],
      sponsoredPaymentMethod,
    } = await setupTestSuite());
  });

  afterAll(async () => {
    await cleanup();
  });

  it("should deploy contract with storage initialized", async () => {
    // Deploy using standard initializer pattern
    const { contract } = await deployMixedUsageContract(
      wallet,
      IMMUTABLES_1,
      INITIAL_COUNTER,
      { fee: { paymentMethod: sponsoredPaymentMethod } },
    );

    // Verify contract was deployed
    expect(contract.address).toBeDefined();
    expect(contract.address.toString()).not.toBe(AztecAddress.ZERO.toString());

    // Read counter via public function - should return initial value
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER);
  });

  it("should allow storage mutation via increment", async () => {
    const { contract } = await deployMixedUsageContract(
      wallet,
      IMMUTABLES_1,
      INITIAL_COUNTER,
      { fee: { paymentMethod: sponsoredPaymentMethod } },
    );

    // Increment counter via public function
    await contract.methods.increment_counter().send({ from: alice });

    // Read counter - should be incremented
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER + 1n);
  });

  it("should deploy mixed usage and read immutables back", async () => {
    const { contract } = await deployMixedUsageContract(
      wallet,
      IMMUTABLES_1,
      INITIAL_COUNTER,
      { fee: { paymentMethod: sponsoredPaymentMethod } },
    );

    // Storage works
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER);

    // Immutables loaded from persistent store (store_immutables called during deployment)
    const result = await contract.methods
      .get_signing_key()
      .simulate({ from: alice });

    expect(result[0]).toEqual(IMMUTABLES_1.signingKeyX.toBigInt());
    expect(result[1]).toEqual(IMMUTABLES_1.signingKeyY.toBigInt());
  });

  it("should verify immutables and increment storage", async () => {
    const { contract } = await deployMixedUsageContract(
      wallet,
      IMMUTABLES_1,
      INITIAL_COUNTER,
      { fee: { paymentMethod: sponsoredPaymentMethod } },
    );

    // The combined private+public function should succeed:
    // 1. Verifies immutables in private context (loaded from persistent store)
    // 2. Enqueues a public call to increment storage
    await contract.methods
      .verify_immutables_and_increment()
      .send({ from: alice });

    // Counter should be incremented
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER + 1n);
  });
});
