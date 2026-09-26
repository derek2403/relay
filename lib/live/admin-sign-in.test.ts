// What the admin sign-in offers the connected wallet, and the sign-in every prompt on the page
// shares (lib/live/admin-sign-in.ts).

import assert from "node:assert/strict";
import test from "node:test";

import { zeroAddress } from "viem";

import { ADMIN_SIGN_IN_IDLE, adminSignInStore, adminWalletState } from "./admin-sign-in";

const owner = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const other = "0x2222222222222222222222222222222222222222";

test("no admin sign-in on open or closed relays; otherwise connect, the owner's button, or not the owner", () => {
  assert.equal(adminWalletState({ viewAuth: "open", address: owner, rootOwner: owner }), "off");
  assert.equal(adminWalletState({ viewAuth: "closed", address: owner, rootOwner: owner }), "off");
  assert.equal(adminWalletState({ viewAuth: "token", address: undefined, rootOwner: owner }), "connect");
  assert.equal(adminWalletState({ viewAuth: "token", address: owner, rootOwner: `0x${owner.slice(2).toUpperCase()}` }), "ready");
  assert.equal(adminWalletState({ viewAuth: "token", address: other, rootOwner: owner }), "not-owner");
  // Pinned to someone else, or refused by the relay already.
  assert.equal(adminWalletState({ viewAuth: "token", address: owner, rootOwner: owner, pinnedOwner: other }), "not-owner");
  assert.equal(adminWalletState({ viewAuth: "token", address: owner, rootOwner: undefined, refused: owner }), "not-owner");
  assert.equal(adminWalletState({ viewAuth: "token", address: owner, rootOwner: undefined, refused: other }), "ready");
});

test("a relay without RELAY_ROOT_NAME has no owner to sign in: only the token page", () => {
  assert.equal(adminWalletState({ viewAuth: "token", relayRoot: null, address: owner, rootOwner: owner }), "off");
  assert.equal(adminWalletState({ viewAuth: "token", relayRoot: null, address: undefined, rootOwner: undefined }), "off");
  assert.equal(adminWalletState({ viewAuth: "token", relayRoot: "acme.eth", address: owner, rootOwner: owner }), "ready");
});

test("an owner the tree hasn't read yet leaves it to the relay", () => {
  for (const rootOwner of [undefined, null, zeroAddress, "not an address"]) {
    assert.equal(adminWalletState({ viewAuth: "token", address: owner, rootOwner }), "ready");
  }
  // Status not loaded yet: offer it; the relay refuses when admin sign-in is off.
  assert.equal(adminWalletState({ viewAuth: undefined, address: owner, rootOwner: owner }), "ready");
});

test("one sign-in at a time for the whole page, and a refusal every prompt sees", () => {
  const store = adminSignInStore();
  assert.equal(store.get(), ADMIN_SIGN_IN_IDLE, "starts idle, like the server snapshot");
  let renders = 0;
  const unsubscribe = store.subscribe(() => renders++);

  assert.equal(store.begin(), true);
  assert.equal(store.get().busy, "sign");
  // A second prompt's click while the wallet is open doesn't ask it again.
  assert.equal(store.begin(), false);
  store.phase("verify");
  assert.equal(store.begin(), false);
  store.refuse(other);
  store.end();
  assert.deepEqual(store.get(), { busy: null, refused: other });
  assert.equal(renders, 4);

  // Free again, and the refusal stays for that wallet.
  assert.equal(store.begin(), true);
  store.end();
  assert.equal(store.get().refused, other);
  unsubscribe();
  store.begin();
  assert.equal(renders, 6, "no calls after unsubscribing");
});
