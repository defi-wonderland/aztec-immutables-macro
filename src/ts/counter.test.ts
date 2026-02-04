import { CounterContract } from "../artifacts/Counter.js";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { TestWallet } from "@aztec/test-wallet/server";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { deployCounter, setupTestSuite } from "./utils.js";

describe("Counter Contract", () => {
  let store: AztecLMDBStoreV2;
  let wallet: TestWallet;
  let alice: AztecAddress;
  let counter: CounterContract;

  beforeAll(async () => {
    ({
      store,
      wallet,
      accounts: [alice],
    } = await setupTestSuite());
  });

  afterAll(async () => {
    await store.delete();
  });

  beforeEach(async () => {
    counter = await deployCounter(wallet, alice);
  });

  it("e2e", async () => {
    const owner = await counter.methods.get_owner().simulate({
      from: alice,
    });
    expect(owner).toStrictEqual(alice);
    // default counter's value is 0
    expect(
      await counter.methods.get_counter().simulate({
        from: alice,
      }),
    ).toBe(0n);
    // call to `increment`
    await counter.methods
      .increment()
      .send({
        from: alice,
      })
      .wait();
    // now the counter should be incremented.
    expect(
      await counter.methods.get_counter().simulate({
        from: alice,
      }),
    ).toBe(1n);
  });
});
