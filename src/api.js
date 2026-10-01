// JSON API for the family trip planner. Platform-neutral: takes a standard Request and a small
// db adapter ({ all, first, run, batch }), so it runs on Cloudflare Workers + D1 and on Node + node:sqlite.
import { statements } from "./schema.js";

export const CATEGORIES = ["attraction", "activity", "food", "shopping", "nature", "stay", "transport", "other"];
export const STATUSES = ["idea", "shortlist", "booked", "dropped"];
export const SLOTS = ["", "morning", "afternoon", "evening"];
const IDEA_FIELDS = ["title", "category", "notes", "place", "link", "cost", "status", "day", "slot"];

const SESSION_DAYS = 120;
const PBKDF2_ITERATIONS = 100_000; // Cloudflare Workers' maximum
// Per name: 5 wrong PINs locks that name for 15 min, and at most 20 wrong PINs a day,
// so even a 4-digit PIN would take years to guess. The organiser's PIN reset clears both.
const LOGIN_LIMIT = { tries: 5, minutes: 15 };
const LOGIN_DAILY = { tries: 20, minutes: 24 * 60 };
const JOIN_LIMIT = { tries: 10, minutes: 30 };     // per IP, guards the family code

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// ---------- crypto ----------

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  return hex(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- validation ----------

function str(v, field, { max, min = 0 }) {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : fail(400, `${field} must be text`);
  if (s.length < min) fail(400, min === 1 ? `${field} is required` : `${field} must be at least ${min} characters`);
  if (s.length > max) fail(400, `${field} is too long (max ${max})`);
  return s;
}
function int(v, field, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${field} must be a whole number from ${min} to ${max}`);
  return n;
}
function oneOf(v, field, list) {
  if (!list.includes(v)) fail(400, `${field} must be one of: ${list.filter(Boolean).join(", ")}`);
  return v;
}
const pinOf = (v) => str(v, "PIN", { min: 4, max: 32 });
const households = (v) => {
  if (!Array.isArray(v) || v.length !== 3) fail(400, "households must be 3 names");
  return v.map((h, i) => str(h, `Household ${i + 1}`, { min: 1, max: 30 }));
};
function cleanIdea(body, current, days) {
  const v = { ...current };
  for (const f of IDEA_FIELDS) if (f in body) v[f] = body[f];
  const link = str(v.link, "Link", { max: 500 });
  if (link && !/^https?:\/\//i.test(link)) fail(400, "Links must start with http:// or https://");
  return {
    title: str(v.title, "Title", { min: 1, max: 100 }),
    category: oneOf(v.category ?? "other", "Type", CATEGORIES),
    notes: str(v.notes, "Details", { max: 2000 }),
    place: str(v.place, "Place", { max: 120 }),
    link,
    cost: str(v.cost, "Cost", { max: 40 }),
    status: oneOf(v.status ?? "idea", "Status", STATUSES),
    day: int(v.day ?? 0, "Day", 0, days),
    slot: oneOf(v.slot ?? "", "Time", SLOTS),
  };
}

// ---------- helpers ----------

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

function sessionCookie(url, token, maxAgeDays) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeDays * 86400}${secure}`;
}
const getCookie = (req, name) => {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
};

// Create tables once per database (per Worker isolate / Node process).
const ready = new WeakMap();
const schemaKey = (db) => db.raw ?? db;
function init(db) {
  const key = schemaKey(db);
  if (!ready.has(key)) {
    ready.set(key, (async () => { for (const s of statements()) await db.run(s); })().catch((e) => { ready.delete(key); throw e; }));
  }
  return ready.get(key);
}

async function throttle(db, key, { tries, minutes }, nowIso, now) {
  const row = await db.first("SELECT count, reset_at FROM throttle WHERE key = ?", key);
  if (row && row.reset_at > nowIso && row.count >= tries) {
    const wait = Math.ceil((Date.parse(row.reset_at) - now) / 60000);
    fail(429, `Too many attempts. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`);
  }
  return {
    failed: () => (row && row.reset_at > nowIso
      ? db.run("UPDATE throttle SET count = count + 1 WHERE key = ?", key)
      : db.run("INSERT OR REPLACE INTO throttle (key, count, reset_at) VALUES (?, 1, ?)", key, new Date(now + minutes * 60000).toISOString())),
    clear: () => db.run("DELETE FROM throttle WHERE key = ?", key),
  };
}

async function startSession(db, url, memberId, nowMs) {
  const token = randomHex(32);
  await db.run("DELETE FROM sessions WHERE expires_at < ?", new Date(nowMs).toISOString());
  await db.run("INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)",
    await sha256(token), memberId, new Date(nowMs + SESSION_DAYS * 86400000).toISOString());
  return { "Set-Cookie": sessionCookie(url, token, SESSION_DAYS) };
}

const bump = ["UPDATE trip SET version = version + 1 WHERE id = 1"];

// ---------- handler ----------

/** Returns a Response for /api/* requests, or null for anything else (serve static files). */
export async function handle(req, db, { ip = "local", now = () => Date.now() } = {}) {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) return null;
  try {
    await init(db);
    const nowMs = now(), nowIso = new Date(nowMs).toISOString();
    const method = req.method;

    let body = {};
    if (method !== "GET" && method !== "HEAD") {
      // Cross-site protection: same-origin JSON only (forms can't send application/json without CORS).
      const origin = req.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) fail(403, "Cross-site request blocked");
      if (!(req.headers.get("Content-Type") || "").includes("application/json")) fail(415, "Send JSON");
      const text = await req.text();
      if (text.length > 20000) fail(413, "Request too large");
      try { body = text ? JSON.parse(text) : {}; } catch { fail(400, "Invalid JSON"); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) fail(400, "Invalid JSON");
    }

    const trip = await db.first("SELECT * FROM trip WHERE id = 1");
    const path = url.pathname.replace(/\/+$/, "");
    const route = `${method} ${path.replace(/\/\d+(?=\/|$)/g, "/:id")}`;
    const ids = [...path.matchAll(/\/(\d+)(?=\/|$)/g)].map((m) => Number(m[1]));

    // Who is calling?
    let me = null;
    const token = getCookie(req, "sid");
    if (token && /^[0-9a-f]{64}$/.test(token)) {
      me = await db.first(
        `SELECT m.id, m.name, m.household, m.is_owner FROM sessions s JOIN members m ON m.id = s.member_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND m.removed = 0`, await sha256(token), nowIso);
    }

    // ----- public endpoints -----

    if (route === "GET /api/session") {
      return json({ setup: !!trip, signedIn: !!me, tripName: me ? trip.name : null });
    }

    if (route === "POST /api/setup") {
      if (trip) fail(409, "This trip has already been set up. Join it with the family code instead.");
      const t = {
        name: str(body.tripName, "Trip name", { min: 1, max: 80 }),
        startDate: /^\d{4}-\d{2}-\d{2}$/.test(body.startDate || "") ? body.startDate : "",
        days: int(body.days ?? 10, "Days", 1, 30),
        households: households(body.households),
        code: str(body.code, "Family code", { min: 6, max: 40 }),
      };
      const name = str(body.name, "Your name", { min: 1, max: 40 });
      const household = int(body.household, "Household", 0, 2);
      const pin = pinOf(body.pin);
      try {
        await db.run("INSERT INTO trip (id, name, start_date, days, households, code) VALUES (1, ?, ?, ?, ?, ?)",
          t.name, t.startDate, t.days, JSON.stringify(t.households), t.code);
      } catch { fail(409, "This trip has already been set up."); }
      const salt = randomHex(16);
      const r = await db.run("INSERT INTO members (name, household, pin_hash, pin_salt, is_owner, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        name, household, await hashPin(pin, salt), salt, nowIso);
      return json({ ok: true }, 200, await startSession(db, url, r.lastId, nowMs));
    }

    // Step 1 of joining: check the code, then show the household names (hidden from anyone without the code).
    if (route === "POST /api/check-code" || route === "POST /api/join") {
      if (!trip) fail(409, "The trip hasn't been set up yet.");
      const limit = await throttle(db, `join:${ip}`, JOIN_LIMIT, nowIso, nowMs);
      const code = str(body.code, "Family code", { min: 1, max: 40 });
      if (!safeEqual(code.toLowerCase(), trip.code.toLowerCase())) {
        await limit.failed();
        fail(403, "That family code isn't right. Check with the organiser.");
      }
      if (route === "POST /api/check-code") return json({ tripName: trip.name, households: JSON.parse(trip.households) });
    }

    if (route === "POST /api/join") {
      const limit = await throttle(db, `join:${ip}`, JOIN_LIMIT, nowIso, nowMs);
      const name = str(body.name, "Your name", { min: 1, max: 40 });
      const household = int(body.household, "Household", 0, 2);
      const pin = pinOf(body.pin);
      const existing = await db.first("SELECT id, removed FROM members WHERE name = ?", name);
      if (existing && !existing.removed) fail(409, `Someone called “${name}” has already joined. Sign in instead, or use a different name.`);
      const salt = randomHex(16);
      const hash = await hashPin(pin, salt);
      let id;
      if (existing) { // rejoining after being removed: keep their history
        await db.run("UPDATE members SET household = ?, pin_hash = ?, pin_salt = ?, removed = 0 WHERE id = ?", household, hash, salt, existing.id);
        id = existing.id;
      } else {
        id = (await db.run("INSERT INTO members (name, household, pin_hash, pin_salt, created_at) VALUES (?, ?, ?, ?, ?)",
          name, household, hash, salt, nowIso)).lastId;
      }
      await limit.clear();
      await db.batch([bump]);
      return json({ ok: true }, 200, await startSession(db, url, id, nowMs));
    }

    if (route === "POST /api/login") {
      const name = str(body.name, "Name", { min: 1, max: 40 });
      const pin = str(body.pin, "PIN", { min: 1, max: 32 });
      const key = name.toLowerCase();
      const limit = await throttle(db, `login:${key}`, LOGIN_LIMIT, nowIso, nowMs);
      const daily = await throttle(db, `loginday:${key}`, LOGIN_DAILY, nowIso, nowMs);
      const m = await db.first("SELECT id, pin_hash, pin_salt FROM members WHERE name = ? AND removed = 0", name);
      // Hash even for unknown names so timing doesn't reveal who has joined.
      const hash = await hashPin(pin, m ? m.pin_salt : "unknown-member");
      if (!m || !safeEqual(hash, m.pin_hash)) {
        await limit.failed();
        await daily.failed();
        fail(401, "Name or PIN isn't right.");
      }
      await limit.clear();
      await daily.clear();
      return json({ ok: true }, 200, await startSession(db, url, m.id, nowMs));
    }

    if (route === "POST /api/logout") {
      if (token) await db.run("DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(url, "", 0) });
    }

    // ----- members only -----

    if (!me) fail(401, "Please sign in.");
    if (!trip) fail(409, "The trip hasn't been set up yet.");
    const isOwner = !!me.is_owner;
    const ownerOnly = () => { if (!isOwner) fail(403, "Only the organiser can do that."); };

    if (route === "GET /api/version") return json({ version: trip.version });

    if (route === "GET /api/state") {
      const [members, ideas, votes, comments, history] = await Promise.all([
        db.all("SELECT id, name, household, is_owner, removed FROM members ORDER BY name"),
        db.all("SELECT * FROM ideas"),
        db.all("SELECT idea_id, member_id, value FROM votes"),
        db.all("SELECT id, idea_id, member_id, text, created_at FROM comments ORDER BY id"),
        db.all("SELECT id, idea_id, member_id, changes, created_at FROM history ORDER BY id"),
      ]);
      const byIdea = new Map(ideas.map((i) => [i.id, {
        id: i.id, title: i.title, category: i.category, notes: i.notes, place: i.place, link: i.link, cost: i.cost,
        status: i.status, day: i.day, slot: i.slot, createdBy: i.created_by, createdAt: i.created_at,
        updatedBy: i.updated_by, updatedAt: i.updated_at, votes: {}, comments: [], history: [],
      }]));
      for (const v of votes) { const i = byIdea.get(v.idea_id); if (i) i.votes[v.member_id] = v.value; }
      for (const c of comments) byIdea.get(c.idea_id)?.comments.push({ id: c.id, by: c.member_id, text: c.text, at: c.created_at });
      for (const h of history) byIdea.get(h.idea_id)?.history.push({ id: h.id, by: h.member_id, changes: JSON.parse(h.changes), at: h.created_at });
      return json({
        version: trip.version,
        trip: { name: trip.name, startDate: trip.start_date, days: trip.days, households: JSON.parse(trip.households), ...(isOwner ? { code: trip.code } : {}) },
        me: { id: me.id, name: me.name, household: me.household, isOwner },
        members: members.map((m) => ({ id: m.id, name: m.name, household: m.household, isOwner: !!m.is_owner, removed: !!m.removed })),
        ideas: [...byIdea.values()],
      });
    }

    if (route === "POST /api/ideas") {
      const v = cleanIdea(body, {}, trip.days);
      const r = await db.run(
        `INSERT INTO ideas (title, category, notes, place, link, cost, status, day, slot, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        v.title, v.category, v.notes, v.place, v.link, v.cost, v.status, v.day, v.slot, me.id, nowIso, me.id, nowIso);
      // Suggesting something counts as liking it.
      await db.batch([["INSERT INTO votes (idea_id, member_id, value) VALUES (?, ?, 1)", r.lastId, me.id], bump]);
      return json({ id: r.lastId }, 201);
    }

    const idea = ids[0] && route.startsWith(`${method} /api/ideas/:id`) ? await db.first("SELECT * FROM ideas WHERE id = ?", ids[0]) : null;
    const needIdea = () => idea || fail(404, "That idea no longer exists.");

    if (route === "PATCH /api/ideas/:id") {
      needIdea();
      const v = cleanIdea(body, idea, trip.days);
      const changes = {};
      for (const f of IDEA_FIELDS) if (v[f] !== idea[f]) changes[f] = [idea[f], v[f]];
      if (!Object.keys(changes).length) return json({ ok: true, changed: false });
      await db.batch([
        [`UPDATE ideas SET title = ?, category = ?, notes = ?, place = ?, link = ?, cost = ?, status = ?, day = ?, slot = ?,
          updated_by = ?, updated_at = ? WHERE id = ?`,
          v.title, v.category, v.notes, v.place, v.link, v.cost, v.status, v.day, v.slot, me.id, nowIso, idea.id],
        ["INSERT INTO history (idea_id, member_id, changes, created_at) VALUES (?, ?, ?, ?)", idea.id, me.id, JSON.stringify(changes), nowIso],
        bump,
      ]);
      return json({ ok: true, changed: true });
    }

    if (route === "DELETE /api/ideas/:id") {
      needIdea();
      if (idea.created_by !== me.id && !isOwner) fail(403, "Only the person who suggested it (or the organiser) can delete it.");
      await db.batch([
        ["DELETE FROM votes WHERE idea_id = ?", idea.id],
        ["DELETE FROM comments WHERE idea_id = ?", idea.id],
        ["DELETE FROM history WHERE idea_id = ?", idea.id],
        ["DELETE FROM ideas WHERE id = ?", idea.id],
        bump,
      ]);
      return json({ ok: true });
    }

    if (route === "PUT /api/ideas/:id/vote") {
      needIdea();
      const value = int(body.value, "Vote", -1, 1);
      await db.batch([
        value === 0
          ? ["DELETE FROM votes WHERE idea_id = ? AND member_id = ?", idea.id, me.id]
          : ["INSERT INTO votes (idea_id, member_id, value) VALUES (?, ?, ?) ON CONFLICT (idea_id, member_id) DO UPDATE SET value = excluded.value", idea.id, me.id, value],
        bump,
      ]);
      return json({ ok: true });
    }

    if (route === "POST /api/ideas/:id/comments") {
      needIdea();
      const text = str(body.text, "Comment", { min: 1, max: 1000 });
      await db.batch([["INSERT INTO comments (idea_id, member_id, text, created_at) VALUES (?, ?, ?, ?)", idea.id, me.id, text, nowIso], bump]);
      return json({ ok: true }, 201);
    }

    if (route === "DELETE /api/comments/:id") {
      const c = await db.first("SELECT id, member_id FROM comments WHERE id = ?", ids[0]);
      if (!c) fail(404, "That comment no longer exists.");
      if (c.member_id !== me.id && !isOwner) fail(403, "You can only delete your own comments.");
      await db.batch([["DELETE FROM comments WHERE id = ?", c.id], bump]);
      return json({ ok: true });
    }

    if (route === "PATCH /api/me") {
      const name = str(body.name, "Name", { min: 1, max: 40 });
      const household = int(body.household, "Household", 0, 2);
      const clash = await db.first("SELECT id FROM members WHERE name = ? AND id != ?", name, me.id);
      if (clash) fail(409, `The name “${name}” is taken.`);
      const stmts = [["UPDATE members SET name = ?, household = ? WHERE id = ?", name, household, me.id], bump];
      if (body.pin) {
        const salt = randomHex(16);
        stmts.push(["UPDATE members SET pin_hash = ?, pin_salt = ? WHERE id = ?", await hashPin(pinOf(body.pin), salt), salt, me.id]);
      }
      await db.batch(stmts);
      return json({ ok: true });
    }

    if (route === "PATCH /api/trip") {
      ownerOnly();
      await db.batch([[
        "UPDATE trip SET name = ?, start_date = ?, days = ?, households = ?, code = ? WHERE id = 1",
        str(body.name, "Trip name", { min: 1, max: 80 }),
        /^\d{4}-\d{2}-\d{2}$/.test(body.startDate || "") ? body.startDate : "",
        int(body.days, "Days", 1, 30),
        JSON.stringify(households(body.households)),
        str(body.code, "Family code", { min: 6, max: 40 }),
      ], bump]);
      return json({ ok: true });
    }

    if (route === "DELETE /api/members/:id") {
      ownerOnly();
      if (ids[0] === me.id) fail(400, "You can't remove yourself.");
      await db.batch([
        ["UPDATE members SET removed = 1 WHERE id = ?", ids[0]],
        ["DELETE FROM sessions WHERE member_id = ?", ids[0]],
        ["DELETE FROM votes WHERE member_id = ?", ids[0]],
        bump,
      ]);
      return json({ ok: true });
    }

    if (route === "POST /api/members/:id/pin") {
      ownerOnly();
      const salt = randomHex(16);
      const r = await db.run("UPDATE members SET pin_hash = ?, pin_salt = ? WHERE id = ? AND removed = 0",
        await hashPin(pinOf(body.pin), salt), salt, ids[0]);
      if (!r.changes) fail(404, "No such member.");
      const m = await db.first("SELECT name FROM members WHERE id = ?", ids[0]);
      await db.batch([
        ["DELETE FROM sessions WHERE member_id = ?", ids[0]],
        ["DELETE FROM throttle WHERE key IN (?, ?)", `login:${m.name.toLowerCase()}`, `loginday:${m.name.toLowerCase()}`],
      ]);
      return json({ ok: true });
    }

    fail(404, "Not found");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong on the server." }, 500);
  }
}
