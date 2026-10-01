// Security rules tests against the Firestore emulator: `npm test`.
import { test, before, after } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, deleteDoc, collection, collectionGroup, getDocs, writeBatch, serverTimestamp,
} from "firebase/firestore";

let env;
const CODE = "mango-1234";
const trip = { name: "Family Holiday", startDate: "2026-12-10", days: 10, households: ["Tan", "Lim", "Wong"] };
const member = (name, household = 0, code = CODE) => ({ name, household, code, email: "", photo: "", joinedAt: serverTimestamp() });
const idea = (by, extra = {}) => ({
  title: "Night Safari", category: "attraction", notes: "", place: "Mandai", link: "", cost: "$55",
  status: "idea", day: 0, slot: "", createdBy: by, createdByName: by, createdAt: serverTimestamp(),
  updatedBy: by, updatedByName: by, updatedAt: serverTimestamp(), ...extra,
});
const db = (uid) => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-family-trip",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") },
  });
});
after(() => env.cleanup());

test("signed-out visitors can read nothing", async () => {
  await assertFails(getDoc(doc(db(), "config/trip")));
  await assertFails(getDocs(collection(db(), "ideas")));
});

test("first person sets up the trip and becomes owner; nobody can take it over", async () => {
  const a = db("alice");
  const b = writeBatch(a);
  b.set(doc(a, "config/secret"), { code: CODE, owner: "alice" });
  b.set(doc(a, "config/trip"), trip);
  b.set(doc(a, "members/alice"), member("Alice", 0));
  await assertSucceeds(b.commit());

  const m = db("mallory");
  await assertFails(setDoc(doc(m, "config/secret"), { code: "mine-0000", owner: "mallory" }));
  await assertFails(setDoc(doc(m, "config/trip"), { ...trip, name: "Hijacked" }));
});

test("joining needs the right family code", async () => {
  const bob = db("bob");
  await assertSucceeds(getDoc(doc(bob, "config/trip")));       // join screen can show households
  await assertSucceeds(getDoc(doc(bob, "members/bob")));       // can check "am I a member?"
  await assertFails(getDoc(doc(bob, "config/secret")));        // but never the code
  await assertFails(getDocs(collection(bob, "ideas")));
  await assertFails(setDoc(doc(bob, "members/bob"), member("Bob", 1, "wrong-code")));
  await assertFails(setDoc(doc(bob, "members/carol"), member("Not Carol", 1)));  // only yourself
  await assertSucceeds(setDoc(doc(bob, "members/bob"), member("Bob", 1)));
  await assertSucceeds(getDocs(collection(bob, "ideas")));
  await assertSucceeds(getDocs(collection(bob, "members")));
});

test("members suggest, anyone edits (with history), only creator or owner deletes", async () => {
  const bob = db("bob"), alice = db("alice");
  await assertSucceeds(setDoc(doc(bob, "ideas/safari"), idea("bob")));
  await assertFails(setDoc(doc(bob, "ideas/fake"), idea("alice")));                       // can't post as someone else
  await assertFails(setDoc(doc(bob, "ideas/bad"), idea("bob", { category: "casino" })));  // validated fields
  await assertFails(setDoc(doc(bob, "ideas/bad2"), idea("bob", { day: 99 })));

  const cur = (await getDoc(doc(alice, "ideas/safari"))).data();
  const batch = writeBatch(alice);
  batch.set(doc(alice, "ideas/safari"), { ...cur, day: 3, slot: "evening", updatedBy: "alice", updatedByName: "Alice", updatedAt: serverTimestamp() });
  batch.set(doc(collection(alice, "ideas/safari/history")), { by: "alice", byName: "Alice", at: serverTimestamp(), changes: { day: [0, 3] } });
  await assertSucceeds(batch.commit());
  await assertFails(setDoc(doc(alice, "ideas/safari"), { ...cur, createdBy: "alice" }));  // can't steal authorship

  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "members/carol"), member("Carol", 2)));
  await assertFails(deleteDoc(doc(db("carol"), "ideas/safari")));    // not creator, not owner
  await assertSucceeds(setDoc(doc(bob, "ideas/zoo"), idea("bob", { title: "Zoo" })));
  await assertSucceeds(deleteDoc(doc(bob, "ideas/zoo")));            // creator
});

test("votes are one per person and only your own", async () => {
  const carol = db("carol");
  await assertSucceeds(setDoc(doc(carol, "ideas/safari/votes/carol"), { value: 1, at: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(carol, "ideas/safari/votes/carol"), { value: -1, at: serverTimestamp() }));
  await assertFails(setDoc(doc(carol, "ideas/safari/votes/carol"), { value: 5, at: serverTimestamp() }));
  await assertFails(setDoc(doc(carol, "ideas/safari/votes/bob"), { value: -1, at: serverTimestamp() }));
  await assertSucceeds(getDocs(collectionGroup(carol, "votes")));
  await assertFails(getDocs(collectionGroup(db("mallory"), "votes")));
});

test("comments: post as yourself; delete your own, or any as owner", async () => {
  const bob = db("bob"), carol = db("carol");
  await assertSucceeds(setDoc(doc(bob, "ideas/safari/comments/c1"), { text: "Kids will love it", by: "bob", byName: "Bob", at: serverTimestamp() }));
  await assertFails(setDoc(doc(bob, "ideas/safari/comments/c2"), { text: "fake", by: "carol", byName: "Carol", at: serverTimestamp() }));
  await assertFails(deleteDoc(doc(carol, "ideas/safari/comments/c1")));
  await assertSucceeds(deleteDoc(doc(db("alice"), "ideas/safari/comments/c1")));
  await assertSucceeds(getDocs(collectionGroup(carol, "comments")));
});

test("owner manages trip settings and members", async () => {
  const alice = db("alice"), bob = db("bob");
  await assertSucceeds(getDoc(doc(alice, "config/secret")));
  await assertFails(setDoc(doc(bob, "config/trip"), { ...trip, days: 12 }));
  await assertSucceeds(setDoc(doc(alice, "config/trip"), { ...trip, days: 12 }));
  await assertFails(deleteDoc(doc(bob, "members/carol")));
  await assertSucceeds(deleteDoc(doc(alice, "members/carol")));
  await assertFails(getDocs(collection(db("carol"), "ideas")));    // removed = locked out
  await assertFails(setDoc(doc(bob, "members/bob"), { ...member("Bob", 1), code: "other" })); // can't alter own code
});
