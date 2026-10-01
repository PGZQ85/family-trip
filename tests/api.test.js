// API tests against an in-memory SQLite database: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/api.js";
import { openDb } from "../src/sqlite-db.js";

const db = openDb(":memory:");
let clock = Date.parse("2026-10-01T10:00:00Z");

// A tiny client that keeps one session cookie, like a browser.
function client(ip = "1.1.1.1") {
  let cookie = "";
  const call = async (method, path, body, headers = {}) => {
    const res = await handle(new Request(`https://trip.example${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }), db, { ip, now: () => clock });
    const set = res.headers.get("Set-Cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return { status: res.status, body: await res.json(), setCookie: set };
  };
  return { call, get: (p) => call("GET", p), post: (p, b = {}) => call("POST", p, b), patch: (p, b) => call("PATCH", p, b), put: (p, b) => call("PUT", p, b), del: (p) => call("DELETE", p, {}) };
}

const alice = client(), bob = client("2.2.2.2"), carol = client("3.3.3.3"), stranger = client("6.6.6.6");
const setup = { tripName: "Tan Family Holiday", startDate: "2026-12-10", days: 10, households: ["Tan", "Lim", "Wong"], code: "mango-otter-4821", name: "Alice", household: 0, pin: "1357" };

test("nothing is readable before signing in", async () => {
  assert.deepEqual((await stranger.get("/api/session")).body, { setup: false, signedIn: false, tripName: null });
  assert.equal((await stranger.get("/api/state")).status, 401);
});

test("first person sets up the trip and is signed in as organiser; it can't be set up twice", async () => {
  const r = await alice.post("/api/setup", setup);
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
  const s = (await alice.get("/api/state")).body;
  assert.equal(s.me.isOwner, true);
  assert.equal(s.trip.code, "mango-otter-4821");
  assert.equal((await stranger.post("/api/setup", { ...setup, name: "Mallory" })).status, 409);
});

test("joining needs the family code; names are unique", async () => {
  assert.equal((await bob.post("/api/check-code", { code: "nope" })).status, 403);
  assert.deepEqual((await bob.post("/api/check-code", { code: setup.code })).body, { tripName: "Tan Family Holiday", households: ["Tan", "Lim", "Wong"] });
  assert.equal((await bob.post("/api/join", { code: "wrong", name: "Bob", household: 1, pin: "2468" })).status, 403);
  assert.equal((await bob.post("/api/join", { code: "MANGO-OTTER-4821", name: "Bob", household: 1, pin: "2468" })).status, 200);
  const s = (await bob.get("/api/state")).body;
  assert.equal(s.me.name, "Bob");
  assert.equal(s.me.isOwner, false);
  assert.equal(s.trip.code, undefined, "only the organiser sees the code");
  assert.equal((await carol.post("/api/join", { code: setup.code, name: "bob", household: 2, pin: "9999" })).status, 409);
  assert.equal((await carol.post("/api/join", { code: setup.code, name: "Carol", household: 2, pin: "12" })).status, 400, "PIN too short");
  assert.equal((await carol.post("/api/join", { code: setup.code, name: "Carol", household: 2, pin: "8642" })).status, 200);
});

test("guessing the family code is rate limited per IP", async () => {
  const guesser = client("9.9.9.9");
  for (let i = 0; i < 10; i++) assert.equal((await guesser.post("/api/join", { code: `guess-${i}`, name: "X", household: 0, pin: "0000" })).status, 403);
  assert.equal((await guesser.post("/api/join", { code: setup.code, name: "X", household: 0, pin: "0000" })).status, 429);
});

test("sign in with name + PIN; wrong PINs lock the name for a while", async () => {
  const phone = client("4.4.4.4");
  assert.equal((await phone.post("/api/login", { name: "bob", pin: "2468" })).status, 200, "names are case-insensitive");
  assert.equal((await phone.get("/api/state")).body.me.name, "Bob");
  await phone.post("/api/logout");
  assert.equal((await phone.get("/api/state")).status, 401);

  const thief = client("5.5.5.5");
  for (let i = 0; i < 5; i++) assert.equal((await thief.post("/api/login", { name: "Carol", pin: `000${i}` })).status, 401);
  assert.equal((await thief.post("/api/login", { name: "Carol", pin: "8642" })).status, 429, "locked even with the right PIN");
  clock += 16 * 60000;
  assert.equal((await thief.post("/api/login", { name: "Carol", pin: "8642" })).status, 200, "unlocks after 15 minutes");
  await thief.post("/api/logout");
});

test("concurrent wrong PINs and family codes are all counted", async () => {
  const burst = (n, req) => Promise.all(Array.from({ length: n }, (_, i) => req(i)));
  const statuses = (rs) => rs.map((r) => r.status).sort();

  const thief = client("7.7.7.7");
  const logins = await burst(8, (i) => thief.post("/api/login", { name: "Bob", pin: `100${i}` }));
  assert.deepEqual(statuses(logins), [401, 401, 401, 401, 401, 429, 429, 429], "only 5 guesses get checked");
  assert.equal((await thief.post("/api/login", { name: "Bob", pin: "2468" })).status, 429, "still locked");
  clock += 16 * 60000;

  const guesser = client("8.8.8.8");
  const codes = await burst(14, (i) => guesser.post("/api/check-code", { code: `guess-${i}` }));
  assert.deepEqual(statuses(codes), [...Array(10).fill(403), ...Array(4).fill(429)]);
  assert.equal((await guesser.post("/api/check-code", { code: setup.code })).status, 429);
  clock += 31 * 60000;
});

let safari;
test("members suggest ideas (auto-liked); input is validated", async () => {
  const r = await alice.post("/api/ideas", { title: "Night Safari", category: "attraction", place: "Mandai", cost: "$55", notes: "After dinner" });
  assert.equal(r.status, 201);
  safari = r.body.id;
  assert.equal((await bob.post("/api/ideas", { title: "", category: "food" })).status, 400);
  assert.equal((await bob.post("/api/ideas", { title: "X", category: "casino" })).status, 400);
  assert.equal((await bob.post("/api/ideas", { title: "X", category: "food", day: 11 })).status, 400, "only 10 days");
  assert.equal((await bob.post("/api/ideas", { title: "X", category: "food", link: "javascript:alert(1)" })).status, 400);
  assert.equal((await stranger.post("/api/ideas", { title: "Spam", category: "food" })).status, 401);
  const idea = (await bob.get("/api/state")).body.ideas.find((i) => i.id === safari);
  assert.equal(idea.title, "Night Safari");
  assert.deepEqual(idea.votes, { 1: 1 });
});

test("anyone can edit an idea; each change is logged; the version moves", async () => {
  const v0 = (await bob.get("/api/version")).body.version;
  assert.equal((await bob.patch(`/api/ideas/${safari}`, { day: 3, slot: "evening" })).body.changed, true);
  assert.equal((await bob.patch(`/api/ideas/${safari}`, { day: 3 })).body.changed, false, "no-op edits aren't logged");
  const idea = (await alice.get("/api/state")).body.ideas.find((i) => i.id === safari);
  assert.equal(idea.day, 3);
  assert.equal(idea.history.length, 1);
  assert.deepEqual(idea.history[0].changes, { day: [0, 3], slot: ["", "evening"] });
  assert.equal(idea.history[0].by, 2);
  assert.ok((await bob.get("/api/version")).body.version > v0);
});

test("one vote per person, changeable and removable", async () => {
  await bob.put(`/api/ideas/${safari}/vote`, { value: 1 });
  await carol.put(`/api/ideas/${safari}/vote`, { value: -1 });
  await carol.put(`/api/ideas/${safari}/vote`, { value: 1 });
  assert.equal((await carol.put(`/api/ideas/${safari}/vote`, { value: 5 })).status, 400);
  let idea = (await alice.get("/api/state")).body.ideas.find((i) => i.id === safari);
  assert.deepEqual(idea.votes, { 1: 1, 2: 1, 3: 1 });
  await carol.put(`/api/ideas/${safari}/vote`, { value: 0 });
  idea = (await alice.get("/api/state")).body.ideas.find((i) => i.id === safari);
  assert.deepEqual(idea.votes, { 1: 1, 2: 1 });
});

test("comments: delete your own, or any as organiser", async () => {
  await bob.post(`/api/ideas/${safari}/comments`, { text: "Kids will love it" });
  const c = (await bob.get("/api/state")).body.ideas.find((i) => i.id === safari).comments[0];
  assert.equal(c.text, "Kids will love it");
  assert.equal((await carol.del(`/api/comments/${c.id}`)).status, 403);
  assert.equal((await alice.del(`/api/comments/${c.id}`)).status, 200);
});

test("only the creator or organiser can delete an idea", async () => {
  const zoo = (await bob.post("/api/ideas", { title: "Zoo", category: "attraction" })).body.id;
  assert.equal((await carol.del(`/api/ideas/${zoo}`)).status, 403);
  assert.equal((await bob.del(`/api/ideas/${zoo}`)).status, 200);
  const beach = (await bob.post("/api/ideas", { title: "Beach", category: "nature" })).body.id;
  assert.equal((await alice.del(`/api/ideas/${beach}`)).status, 200);
});

test("organiser settings, PIN reset and removing members", async () => {
  assert.equal((await bob.patch("/api/trip", { name: "Hijack", startDate: "", days: 10, households: ["a", "b", "c"], code: "aaaaaa" })).status, 403);
  assert.equal((await alice.patch("/api/trip", { ...setup, name: "Tan Family Holiday 2026", days: 10 })).status, 200);
  assert.equal((await bob.post("/api/members/3/pin", { pin: "1111" })).status, 403);
  assert.equal((await alice.post("/api/members/3/pin", { pin: "1111" })).status, 200);
  assert.equal((await carol.get("/api/state")).status, 401, "PIN reset signs them out");
  assert.equal((await carol.post("/api/login", { name: "Carol", pin: "1111" })).status, 200);
  assert.equal((await alice.del("/api/members/3")).status, 200);
  assert.equal((await carol.get("/api/state")).status, 401, "removed = signed out");
  assert.equal((await carol.post("/api/login", { name: "Carol", pin: "1111" })).status, 401);
  const s = (await alice.get("/api/state")).body;
  assert.equal(s.members.find((m) => m.id === 3).removed, true);
  assert.deepEqual(s.ideas.find((i) => i.id === safari).votes, { 1: 1, 2: 1 });
  assert.equal((await carol.post("/api/join", { code: setup.code, name: "Carol", household: 2, pin: "7777" })).status, 200, "can rejoin with the code");
});

test("cross-site writes and non-JSON bodies are refused", async () => {
  assert.equal((await bob.call("POST", "/api/ideas", { title: "x", category: "food" }, { Origin: "https://evil.example" })).status, 403);
  const res = await handle(new Request("https://trip.example/api/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "name=Bob&pin=2468" }), db);
  assert.equal(res.status, 415);
});
