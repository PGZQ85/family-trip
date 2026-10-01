import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut,
  connectAuthEmulator, signInWithCredential,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, deleteDoc, addDoc, collection, collectionGroup,
  onSnapshot, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

// ---------- constants ----------

const CATEGORIES = {
  attraction: "🎡 Attraction", activity: "🏄 Activity", food: "🍜 Food", shopping: "🛍️ Shopping",
  nature: "🌿 Nature", stay: "🏨 Stay", transport: "🚆 Transport", other: "✨ Other",
};
const STATUSES = { idea: "Idea", shortlist: "Shortlisted", booked: "Booked", dropped: "Dropped" };
const SLOTS = { "": "Any time", morning: "Morning", afternoon: "Afternoon", evening: "Evening" };
const FIELD_LABELS = { title: "title", category: "type", notes: "details", place: "place", link: "link", cost: "cost", status: "status", day: "day", slot: "time" };

// ---------- helpers ----------

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const options = (map, selected) => Object.entries(map).map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(selected) ? " selected" : ""}>${esc(l)}</option>`).join("");
const initials = (name) => (name || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

function ago(ts) {
  if (!ts || !ts.toDate) return "just now";
  const s = (Date.now() - ts.toDate().getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return ts.toDate().toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function dayDate(n) {
  if (!state.trip?.startDate) return "";
  const d = new Date(state.trip.startDate + "T00:00:00");
  d.setDate(d.getDate() + n - 1);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
const dayLabel = (n) => (n ? `Day ${n}` : "Not scheduled");
function dayOptions(selected) {
  const days = { 0: "Not scheduled" };
  for (let i = 1; i <= (state.trip?.days || 10); i++) days[i] = `Day ${i}${dayDate(i) ? " · " + dayDate(i) : ""}`;
  return options(days, selected);
}

function randomCode() {
  const words = ["beach", "mango", "panda", "sunny", "island", "durian", "lantern", "kite", "coconut", "otter"];
  const w = words[Math.floor(Math.random() * words.length)];
  return `${w}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function avatar(m) {
  if (m?.photo) return `<img class="avatar" src="${esc(m.photo)}" alt="" referrerpolicy="no-referrer">`;
  return `<span class="avatar" style="background:var(--h${m?.household ?? 0})">${esc(initials(m?.name))}</span>`;
}
const memberName = (uid, fallback) => state.members.get(uid)?.name || fallback || "Someone";
const hhDot = (uid) => {
  const m = state.members.get(uid);
  return m ? `<span class="hh hh-${m.household}" title="${esc(state.trip.households[m.household])}"></span>` : "";
};

// ---------- firebase ----------

// Local testing: http://localhost:5174/?emu=alice runs against the Firebase emulators as a fake user "alice".
const emu = ["localhost", "127.0.0.1"].includes(location.hostname) ? new URLSearchParams(location.search).get("emu") : null;
const configured = emu || !String(firebaseConfig.apiKey).startsWith("PASTE");
let auth, db;
if (configured) {
  const app = initializeApp(emu ? { apiKey: "demo", projectId: "demo-family-trip", authDomain: "localhost" } : firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  if (emu) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    const name = emu[0].toUpperCase() + emu.slice(1);
    // The auth emulator accepts an unsigned JSON "ID token".
    signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: emu, email: `${emu}@example.com`, email_verified: true, name })));
  }
}

const state = {
  user: null, trip: null, me: null,
  members: new Map(), ideas: new Map(), votes: new Map(), comments: new Map(), history: new Map(),
  view: localStorage.getItem("view") || "ideas",
  filter: { q: "", category: "", status: "active", sort: "top" },
  openIdea: null, unsub: [],
};

// ---------- auth + onboarding ----------

if (!configured) {
  renderNotConfigured();
} else {
  onAuthStateChanged(auth, async (user) => {
    state.unsub.forEach((u) => u());
    state.unsub = [];
    state.user = user;
    renderMe();
    if (!user) return renderSignIn();
    try {
      const tripSnap = await getDoc(doc(db, "config/trip"));
      if (!tripSnap.exists()) return renderSetup();
      state.trip = tripSnap.data();
      renderHeader();
      const meSnap = await getDoc(doc(db, "members", user.uid));
      if (!meSnap.exists()) return renderJoin();
      startApp();
    } catch (e) {
      console.error(e);
      main(`<div class="panel"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`);
    }
  });
}

function main(html) { $("#main").innerHTML = html; }

function renderNotConfigured() {
  main(`<div class="panel">
    <h2>Almost there</h2>
    <p class="lead">This app needs a free Firebase project for sign-in and the shared database.</p>
    <p>Follow the steps in <b>SETUP.md</b> in the repository, then paste your web config into <code>firebase-config.js</code>.</p>
  </div>`);
}

function renderMe() {
  const u = state.user;
  $("#me").innerHTML = u
    ? `${state.me ? avatar(state.me) : ""}<span class="name">${esc(state.me?.name || u.displayName || u.email)}</span>
       <button class="btn small" id="signout">Sign out</button>`
    : "";
  const so = $("#signout");
  if (so) so.onclick = () => signOut(auth);
}

function renderHeader() {
  const t = state.trip;
  $("#trip-name").textContent = t?.name || "Family Trip Planner";
  document.title = t?.name ? `${t.name} · Trip Planner` : "Family Trip Planner";
  if (t?.startDate) {
    const end = new Date(t.startDate + "T00:00:00");
    end.setDate(end.getDate() + t.days - 1);
    const f = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    $("#trip-dates").textContent = `${t.days} days · ${f(new Date(t.startDate + "T00:00:00"))} – ${f(end)}`;
  } else $("#trip-dates").textContent = t ? `${t.days} days` : "";
}

function renderSignIn() {
  $("#tabs").hidden = true;
  main(`<div class="panel">
    <h2>Welcome 👋</h2>
    <p class="lead">Suggest places to visit and things to do, vote on everyone's ideas and plan the days together.</p>
    <button class="btn primary" id="google">Sign in with Google</button>
    <p class="form-error" id="signin-error"></p>
  </div>`);
  $("#google").onclick = async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try { await signInWithPopup(auth, provider); }
    catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") return signInWithRedirect(auth, provider);
      if (e.code !== "auth/popup-closed-by-user") $("#signin-error").textContent = e.message;
    }
  };
}

function renderSetup() {
  const u = state.user;
  main(`<form class="panel" id="setup">
    <h2>Set up your family trip</h2>
    <p>You're the first one here, so you'll be the trip organiser. Everyone else joins with the family code below.</p>
    <label>Trip name <input name="name" required maxlength="80" value="Family Holiday"></label>
    <div class="row">
      <label>First day <input name="startDate" type="date"></label>
      <label>Number of days <input name="days" type="number" min="1" max="30" value="10" required></label>
    </div>
    <label>Household names</label>
    <div class="row">
      <input name="h0" required maxlength="30" value="Household 1" aria-label="Household 1">
      <input name="h1" required maxlength="30" value="Household 2" aria-label="Household 2">
      <input name="h2" required maxlength="30" value="Household 3" aria-label="Household 3">
    </div>
    <br>
    <label>Family code (share this with the family) <input name="code" required minlength="6" maxlength="40" value="${esc(randomCode())}"></label>
    <div class="row">
      <label>Your name <input name="me" required maxlength="40" value="${esc(u.displayName || "")}"></label>
      <label>Your household <select name="household"><option value="0">Household 1</option><option value="1">Household 2</option><option value="2">Household 3</option></select></label>
    </div>
    <p class="form-error" id="setup-error"></p>
    <button class="btn primary" type="submit">Create trip</button>
  </form>`);
  const f = $("#setup");
  // Keep the household picker in sync with the names typed above.
  const syncNames = () => [0, 1, 2].forEach((i) => { f.household.options[i].textContent = f[`h${i}`].value || `Household ${i + 1}`; });
  ["h0", "h1", "h2"].forEach((n) => f[n].addEventListener("input", syncNames));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    const code = f.code.value.trim();
    const trip = {
      name: f.name.value.trim(), startDate: f.startDate.value || "", days: Math.min(30, Math.max(1, parseInt(f.days.value, 10) || 10)),
      households: [f.h0.value.trim(), f.h1.value.trim(), f.h2.value.trim()],
    };
    const batch = writeBatch(db);
    batch.set(doc(db, "config/secret"), { code, owner: u.uid });
    batch.set(doc(db, "config/trip"), trip);
    batch.set(doc(db, "members", u.uid), memberDoc(f.me.value, f.household.value, code));
    try {
      await batch.commit();
      state.trip = trip;
      renderHeader();
      startApp();
    } catch (err) {
      console.error(err);
      $("#setup-error").textContent = err.code === "permission-denied"
        ? "Someone has already set up this trip — reload the page to join it."
        : err.message;
      btn.disabled = false;
    }
  };
}

function memberDoc(name, household, code) {
  const u = state.user;
  return {
    name: name.trim().slice(0, 40), household: parseInt(household, 10), code,
    email: u.email || "", photo: u.photoURL || "", joinedAt: serverTimestamp(),
  };
}

function renderJoin() {
  $("#tabs").hidden = true;
  const h = state.trip.households;
  main(`<form class="panel" id="join">
    <h2>Join “${esc(state.trip.name)}”</h2>
    <p>Ask the trip organiser for the family code.</p>
    <label>Family code <input name="code" required autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row">
      <label>Your name <input name="me" required maxlength="40" value="${esc(state.user.displayName || "")}"></label>
      <label>Household <select name="household">${h.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join("")}</select></label>
    </div>
    <p class="form-error" id="join-error"></p>
    <button class="btn primary" type="submit">Join the trip</button>
  </form>`);
  const f = $("#join");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await setDoc(doc(db, "members", state.user.uid), memberDoc(f.me.value, f.household.value, f.code.value.trim()));
      startApp();
    } catch (err) {
      $("#join-error").textContent = err.code === "permission-denied" ? "That family code isn't right — check with the organiser." : err.message;
      btn.disabled = false;
    }
  };
}

// ---------- live data ----------

function startApp() {
  $("#tabs").hidden = false;
  main(`<p class="loading">Loading ideas…</p>`);
  const u = state.user.uid;
  const loaded = new Set();
  const ready = (k) => { loaded.add(k); if (loaded.size >= 3) render(); };

  state.unsub.push(onSnapshot(doc(db, "config/trip"), (s) => { state.trip = s.data(); renderHeader(); render(); }));
  state.unsub.push(onSnapshot(collection(db, "members"), (s) => {
    state.members = new Map(s.docs.map((d) => [d.id, d.data()]));
    state.me = state.members.get(u) || null;
    if (!state.me && loaded.has("members")) { location.reload(); return; } // removed by the organiser
    renderMe();
    ready("members"); render();
  }, onError));
  state.unsub.push(onSnapshot(collection(db, "ideas"), (s) => {
    state.ideas = new Map(s.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    ready("ideas"); render();
  }, onError));
  state.unsub.push(onSnapshot(collectionGroup(db, "votes"), (s) => {
    state.votes = new Map();
    for (const d of s.docs) {
      const id = d.ref.parent.parent.id;
      if (!state.votes.has(id)) state.votes.set(id, new Map());
      state.votes.get(id).set(d.id, d.data().value);
    }
    ready("votes"); render();
  }, onError));
  state.unsub.push(onSnapshot(collectionGroup(db, "comments"), (s) => {
    state.comments = groupByIdea(s.docs);
    render();
  }, onError));
  state.unsub.push(onSnapshot(collectionGroup(db, "history"), (s) => {
    state.history = groupByIdea(s.docs);
    if (state.openIdea) renderDetail();
  }, onError));
  state.unsub.push(() => { loaded.clear(); });
  isOwnerCheck();
}

function groupByIdea(docs) {
  const m = new Map();
  for (const d of docs) {
    const id = d.ref.parent.parent.id;
    if (!m.has(id)) m.set(id, []);
    m.get(id).push({ id: d.id, ...d.data() });
  }
  for (const list of m.values()) list.sort((a, b) => (a.at?.toMillis?.() ?? Infinity) - (b.at?.toMillis?.() ?? Infinity));
  return m;
}

function onError(e) {
  console.error(e);
  if (e.code === "permission-denied") main(`<div class="panel"><h2>No access</h2><p>You're not a member of this trip (or were removed). Reload to join again.</p></div>`);
}

async function isOwnerCheck() {
  // Only the owner may read config/secret, so a successful read means "I'm the organiser".
  try {
    const s = await getDoc(doc(db, "config/secret"));
    state.owner = s.exists() ? s.data() : null;
  } catch { state.owner = null; }
  render();
}

// ---------- rendering ----------

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!state.me || !state.trip) return;
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
    // Ideas re-renders only its list (keeps the search box); the Family forms are left alone while being edited.
    const editing = $("#main").contains(document.activeElement) && document.activeElement.matches("input, select, textarea");
    if (state.view === "ideas") renderIdeas();
    else if (state.view === "family" && editing) { /* skip */ }
    else if (state.view === "itinerary") renderItinerary();
    else renderFamily();
    if (state.openIdea) renderDetail();
  });
}

function tally(id) {
  const v = state.votes.get(id) || new Map();
  let up = 0, down = 0;
  for (const x of v.values()) x > 0 ? up++ : down++;
  return { up, down, score: up - down, mine: v.get(state.user.uid) || 0 };
}

function filteredIdeas() {
  const { q, category, status, sort } = state.filter;
  const needle = q.trim().toLowerCase();
  let list = [...state.ideas.values()].filter((i) =>
    (!category || i.category === category)
    && (status === "all" || (status === "active" ? i.status !== "dropped" : i.status === status))
    && (!needle || `${i.title} ${i.place} ${i.notes} ${i.createdByName}`.toLowerCase().includes(needle)));
  const t = (i) => i.createdAt?.toMillis?.() ?? Date.now();
  if (sort === "top") list.sort((a, b) => tally(b.id).score - tally(a.id).score || tally(b.id).up - tally(a.id).up || t(b) - t(a));
  else if (sort === "new") list.sort((a, b) => t(b) - t(a));
  else if (sort === "day") list.sort((a, b) => (a.day || 99) - (b.day || 99) || ["", "morning", "afternoon", "evening"].indexOf(a.slot) - ["", "morning", "afternoon", "evening"].indexOf(b.slot));
  else if (sort === "unvoted") list = list.filter((i) => !tally(i.id).mine);
  return list;
}

function renderIdeas() {
  if (!$("#ideas-view")) {
    const f = state.filter;
    main(`<section id="ideas-view">
      <div class="toolbar">
        <button class="btn primary" data-action="new">+ Suggest something</button>
        <input type="search" id="q" placeholder="Search ideas" value="${esc(f.q)}">
        <select id="f-category"><option value="">All types</option>${options(CATEGORIES, f.category)}</select>
        <select id="f-status">${options({ active: "Not dropped", all: "Everything", ...STATUSES }, f.status)}</select>
        <select id="f-sort">${options({ top: "Most liked", new: "Newest", day: "By day", unvoted: "I haven't voted" }, f.sort)}</select>
      </div>
      <div id="idea-list"></div>
    </section>`);
    $("#q").oninput = (e) => { state.filter.q = e.target.value; renderIdeaList(); };
    $("#f-category").onchange = (e) => { state.filter.category = e.target.value; renderIdeaList(); };
    $("#f-status").onchange = (e) => { state.filter.status = e.target.value; renderIdeaList(); };
    $("#f-sort").onchange = (e) => { state.filter.sort = e.target.value; renderIdeaList(); };
  }
  renderIdeaList();
}

function renderIdeaList() {
  const list = filteredIdeas();
  if (!state.ideas.size) {
    $("#idea-list").innerHTML = `<div class="empty"><p>No ideas yet — be the first!</p><button class="btn primary" data-action="new">+ Suggest something</button></div>`;
    return;
  }
  if (!list.length) { $("#idea-list").innerHTML = `<div class="empty">Nothing matches these filters.</div>`; return; }
  $("#idea-list").innerHTML = `<div class="grid">${list.map(cardHTML).join("")}</div>`;
}

function voteButtons(id) {
  const t = tally(id);
  return `<button class="vote up${t.mine > 0 ? " on" : ""}" data-action="vote" data-id="${esc(id)}" data-value="1" title="I like this" aria-pressed="${t.mine > 0}">👍 ${t.up}</button>
    <button class="vote down${t.mine < 0 ? " on" : ""}" data-action="vote" data-id="${esc(id)}" data-value="-1" title="Not for me" aria-pressed="${t.mine < 0}">👎 ${t.down}</button>`;
}

function cardHTML(i) {
  const nComments = (state.comments.get(i.id) || []).length;
  const t = tally(i.id);
  return `<article class="card${i.status === "dropped" ? " dropped" : ""}" data-action="open" data-id="${esc(i.id)}" tabindex="0">
    <div class="card-top">
      <span class="pill">${esc(CATEGORIES[i.category] || i.category)}</span>
      ${i.status !== "idea" ? `<span class="pill st-${esc(i.status)}">${esc(STATUSES[i.status])}</span>` : ""}
      ${i.day ? `<span class="pill day">🗓️ Day ${i.day}${i.slot ? " · " + esc(SLOTS[i.slot]) : ""}</span>` : ""}
    </div>
    <h3>${esc(i.title)}</h3>
    ${i.place ? `<div class="place">📍 ${esc(i.place)}</div>` : ""}
    <div class="by">${hhDot(i.createdBy)} ${esc(memberName(i.createdBy, i.createdByName))} · ${ago(i.createdAt)}${i.cost ? ` · ${esc(i.cost)}` : ""}</div>
    <div class="card-foot">
      ${voteButtons(i.id)}
      <span class="count">💬 ${nComments}</span>
      <span class="score" title="Likes minus dislikes">${t.score > 0 ? "+" : ""}${t.score}</span>
    </div>
  </article>`;
}

function renderItinerary() {
  const days = state.trip.days || 10;
  const ideas = [...state.ideas.values()].filter((i) => i.status !== "dropped");
  const item = (i) => `<button class="slot-item${i.status === "booked" ? " booked" : ""}" data-action="open" data-id="${esc(i.id)}">
      ${i.status === "booked" ? "✅ " : ""}${esc(i.title)} <span class="muted">· ${tally(i.id).score >= 0 ? "+" : ""}${tally(i.id).score}</span></button>`;
  let html = `<div class="toolbar"><p class="muted" style="margin:0">Open any idea and pick a day and time to place it here. ✅ = booked.</p></div><div class="days">`;
  for (let d = 1; d <= days; d++) {
    const today = ideas.filter((i) => i.day === d);
    html += `<section class="day-card"><h3>Day ${d} <span class="muted">${esc(dayDate(d))}</span></h3><div class="slots">`;
    for (const [slot, label] of [["morning", "Morning"], ["afternoon", "Afternoon"], ["evening", "Evening"], ["", "Any time"]]) {
      html += `<div class="slot"><div class="slot-name">${label}</div>${today.filter((i) => (i.slot || "") === slot).map(item).join("")}</div>`;
    }
    html += `</div></section>`;
  }
  html += `</div>`;
  const waiting = ideas.filter((i) => !i.day && i.status === "shortlist").sort((a, b) => tally(b.id).score - tally(a.id).score);
  const popular = ideas.filter((i) => !i.day && i.status === "idea" && tally(i.id).score > 0).sort((a, b) => tally(b.id).score - tally(a.id).score);
  html += `<section class="unscheduled"><h3>Shortlisted, not on a day yet</h3>${waiting.length ? `<div class="grid">${waiting.map(cardHTML).join("")}</div>` : `<p class="muted">Nothing waiting.</p>`}</section>`;
  if (popular.length) html += `<section class="unscheduled"><h3>Popular ideas, not on a day yet</h3><div class="grid">${popular.map(cardHTML).join("")}</div></section>`;
  main(html);
}

function renderFamily() {
  const h = state.trip.households;
  const isOwner = !!state.owner;
  const groups = h.map((name, i) => {
    const ms = [...state.members.entries()].filter(([, m]) => m.household === i).sort((a, b) => a[1].name.localeCompare(b[1].name));
    return `<section class="household"><h3><span class="hh hh-${i}"></span>${esc(name)} <span class="muted">${ms.length}</span></h3>
      ${ms.map(([uid, m]) => `<div class="member">${avatar(m)} <span>${esc(m.name)}${uid === state.user.uid ? ' <span class="muted">(you)</span>' : ""}${uid === state.owner?.owner ? ' <span class="muted">· organiser</span>' : ""}</span>
        ${isOwner && uid !== state.user.uid ? `<button class="btn small danger" data-action="remove-member" data-id="${esc(uid)}">Remove</button>` : ""}</div>`).join("") || '<p class="muted">No one yet</p>'}
    </section>`;
  }).join("");
  const counts = [...state.ideas.values()].reduce((a, i) => { a[i.createdBy] = (a[i.createdBy] || 0) + 1; return a; }, {});
  const meForm = `<form class="household" id="me-form"><h3>Your details</h3>
      <label>Name <input name="name" required maxlength="40" value="${esc(state.me.name)}"></label>
      <label>Household <select name="household">${h.map((n, i) => `<option value="${i}"${i === state.me.household ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
      <p class="muted" style="font-size:13px">You've suggested ${counts[state.user.uid] || 0} idea(s).</p>
      <button class="btn primary small" type="submit">Save</button></form>`;
  const ownerBox = isOwner ? `<section class="household owner-box"><h3>Organiser settings</h3>
      <p class="muted" style="font-size:13px">Share this code so family members can join:</p>
      <div class="code-box">${esc(state.owner.code)}</div>
      <form id="trip-form" style="margin-top:12px">
        <label>Trip name <input name="name" required maxlength="80" value="${esc(state.trip.name)}"></label>
        <div class="row">
          <label>First day <input name="startDate" type="date" value="${esc(state.trip.startDate)}"></label>
          <label>Days <input name="days" type="number" min="1" max="30" value="${state.trip.days}"></label>
        </div>
        ${h.map((n, i) => `<label>Household ${i + 1} <input name="h${i}" required maxlength="30" value="${esc(n)}"></label>`).join("")}
        <label>Family code <input name="code" required minlength="6" maxlength="40" value="${esc(state.owner.code)}"></label>
        <p class="muted" style="font-size:12px">Changing the code doesn't remove anyone — it only affects new joiners.</p>
        <p class="form-error" id="trip-error"></p>
        <button class="btn primary small" type="submit">Save trip settings</button>
      </form></section>` : "";
  main(`<div class="households">${groups}</div><div class="households" style="margin-top:12px">${meForm}${ownerBox}</div>`);

  $("#me-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await setDoc(doc(db, "members", state.user.uid), { ...state.me, name: f.name.value.trim(), household: parseInt(f.household.value, 10) });
  };
  if (isOwner) $("#trip-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const batch = writeBatch(db);
    batch.set(doc(db, "config/trip"), {
      name: f.name.value.trim(), startDate: f.startDate.value || "", days: Math.min(30, Math.max(1, parseInt(f.days.value, 10) || 10)),
      households: [f.h0.value.trim(), f.h1.value.trim(), f.h2.value.trim()],
    });
    const code = f.code.value.trim();
    if (code !== state.owner.code) batch.set(doc(db, "config/secret"), { code, owner: state.owner.owner });
    try { await batch.commit(); state.owner = { ...state.owner, code }; $("#trip-error").textContent = "Saved ✓"; }
    catch (err) { $("#trip-error").textContent = err.message; }
  };
}

// ---------- idea form ----------

const formDialog = $("#idea-form-dialog");
const form = $("#idea-form");
form.category.innerHTML = options(CATEGORIES, "attraction");
form.status.innerHTML = options(STATUSES, "idea");
form.slot.innerHTML = options(SLOTS, "");
let editingId = null;

function openForm(id = null) {
  editingId = id;
  const i = id ? state.ideas.get(id) : { title: "", category: "attraction", notes: "", place: "", link: "", cost: "", status: "idea", day: 0, slot: "" };
  $("#idea-form-title").textContent = id ? "Edit idea" : "Suggest something";
  form.day.innerHTML = dayOptions(i.day);
  for (const k of ["title", "category", "notes", "place", "link", "cost", "status", "slot"]) form[k].value = i[k] ?? "";
  $("#idea-form-error").textContent = "";
  formDialog.showModal();
  form.title.focus();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = {
    title: form.title.value.trim(), category: form.category.value, notes: form.notes.value.trim(),
    place: form.place.value.trim(), link: form.link.value.trim(), cost: form.cost.value.trim(),
    status: form.status.value, day: parseInt(form.day.value, 10) || 0, slot: form.slot.value,
  };
  if (!v.title) return;
  if (v.link && !safeUrl(v.link)) { $("#idea-form-error").textContent = "Links must start with http:// or https://"; return; }
  try {
    if (editingId) await updateIdea(editingId, v);
    else {
      const ref = await addDoc(collection(db, "ideas"), {
        ...v, createdBy: state.user.uid, createdByName: state.me.name, createdAt: serverTimestamp(),
        updatedBy: state.user.uid, updatedByName: state.me.name, updatedAt: serverTimestamp(),
      });
      // Suggesting something counts as liking it.
      await setDoc(doc(db, "ideas", ref.id, "votes", state.user.uid), { value: 1, at: serverTimestamp() });
    }
    formDialog.close();
  } catch (err) {
    console.error(err);
    $("#idea-form-error").textContent = err.message;
  }
});

// Apply changes to an idea and log what changed, in one atomic write.
async function updateIdea(id, patch) {
  const cur = state.ideas.get(id);
  const changes = {};
  for (const [k, v] of Object.entries(patch)) if (cur[k] !== v) changes[k] = [cur[k] ?? "", v];
  if (!Object.keys(changes).length) return;
  const { id: _omit, ...rest } = cur;
  const batch = writeBatch(db);
  batch.set(doc(db, "ideas", id), {
    ...rest, ...patch, updatedBy: state.user.uid, updatedByName: state.me.name, updatedAt: serverTimestamp(),
  });
  batch.set(doc(collection(db, "ideas", id, "history")), { by: state.user.uid, byName: state.me.name, at: serverTimestamp(), changes });
  await batch.commit();
}

// ---------- idea detail ----------

const detailDialog = $("#detail-dialog");
detailDialog.addEventListener("close", () => { state.openIdea = null; });

function openDetail(id) {
  state.openIdea = id;
  renderDetail();
  if (!detailDialog.open) detailDialog.showModal();
}

function describeChange(field, [from, to]) {
  const show = (v) => {
    if (field === "day") return v ? `Day ${v}` : "not scheduled";
    if (field === "slot") return SLOTS[v] || "any time";
    if (field === "status") return STATUSES[v] || v;
    if (field === "category") return CATEGORIES[v] || v;
    const s = String(v || "—");
    return s.length > 40 ? s.slice(0, 40) + "…" : s;
  };
  return field === "notes" ? "updated the details" : `changed ${FIELD_LABELS[field] || field}: ${esc(show(from))} → <b>${esc(show(to))}</b>`;
}

function renderDetail() {
  const i = state.ideas.get(state.openIdea);
  const box = $("#detail");
  if (!i) { detailDialog.close(); return; }
  // Keep a half-written comment when live updates re-render the dialog.
  const draft = $("#comment-text", box)?.value || "";
  const hadFocus = document.activeElement?.id === "comment-text";

  const votes = state.votes.get(i.id) || new Map();
  const voters = (val) => [...votes.entries()].filter(([, v]) => v === val).map(([uid]) => `${hhDot(uid)} ${esc(memberName(uid))}`).join(", ") || '<span class="muted">nobody yet</span>';
  const comments = state.comments.get(i.id) || [];
  const history = (state.history.get(i.id) || []).slice().reverse();
  const canDelete = i.createdBy === state.user.uid || !!state.owner;
  const link = safeUrl(i.link);

  box.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="card-top"><span class="pill">${esc(CATEGORIES[i.category])}</span>${i.status !== "idea" ? `<span class="pill st-${esc(i.status)}">${esc(STATUSES[i.status])}</span>` : ""}</div>
        <h2>${esc(i.title)}</h2>
        <div class="muted" style="font-size:13px">${hhDot(i.createdBy)} Suggested by ${esc(memberName(i.createdBy, i.createdByName))} · ${ago(i.createdAt)}
          ${i.updatedBy && i.updatedAt && history.length ? ` · last edited by ${esc(memberName(i.updatedBy, i.updatedByName))} ${ago(i.updatedAt)}` : ""}</div>
      </div>
      <button class="btn small" data-close aria-label="Close">✕</button>
    </div>
    <div class="facts">
      ${i.place ? `<span>📍 ${esc(i.place)}</span>` : ""}
      ${i.cost ? `<span>💲 ${esc(i.cost)}</span>` : ""}
      ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(new URL(link).hostname)}</a>` : ""}
    </div>
    ${i.notes ? `<p class="notes">${esc(i.notes)}</p>` : ""}

    <div class="quick">
      <label>Status <select data-quick="status">${options(STATUSES, i.status)}</select></label>
      <label>Day <select data-quick="day">${dayOptions(i.day)}</select></label>
      <label>Time <select data-quick="slot">${options(SLOTS, i.slot)}</select></label>
    </div>

    <div class="card-foot">${voteButtons(i.id)}
      <span style="margin-left:auto"></span>
      <button class="btn small" data-action="edit" data-id="${esc(i.id)}">✏️ Edit</button>
      ${canDelete ? `<button class="btn small danger" data-action="delete" data-id="${esc(i.id)}">Delete</button>` : ""}
    </div>
    <div class="voters" style="margin-top:8px"><span>👍 ${voters(1)}</span></div>
    <div class="voters"><span>👎 ${voters(-1)}</span></div>

    <section class="section">
      <h3>Comments (${comments.length})</h3>
      <ul class="comments">${comments.map((c) => `<li>
        <div class="who">${hhDot(c.by)} <b>${esc(memberName(c.by, c.byName))}</b> · ${ago(c.at)}
          ${c.by === state.user.uid || state.owner ? `<button class="linklike" data-action="delete-comment" data-id="${esc(c.id)}">delete</button>` : ""}</div>
        <p>${esc(c.text)}</p></li>`).join("") || '<li class="muted">No comments yet.</li>'}</ul>
      <form class="comment-form" id="comment-form">
        <textarea id="comment-text" rows="2" maxlength="1000" placeholder="Add a comment or suggest a change…" required></textarea>
        <button class="btn primary" type="submit">Post</button>
      </form>
    </section>

    ${history.length ? `<section class="section"><h3>Changes</h3><ul class="history">${history.map((h) =>
      `<li>${hhDot(h.by)} <b>${esc(memberName(h.by, h.byName))}</b> ${Object.entries(h.changes).map(([f, c]) => describeChange(f, c)).join("; ")} · ${ago(h.at)}</li>`).join("")}</ul></section>` : ""}
  `;

  const ta = $("#comment-text", box);
  ta.value = draft;
  if (hadFocus) { ta.focus(); ta.setSelectionRange(draft.length, draft.length); }
  $("#comment-form", box).onsubmit = async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    await addDoc(collection(db, "ideas", i.id, "comments"), { text, by: state.user.uid, byName: state.me.name, at: serverTimestamp() });
  };
  box.querySelectorAll("[data-quick]").forEach((sel) => {
    sel.onchange = () => {
      const k = sel.dataset.quick;
      updateIdea(i.id, { [k]: k === "day" ? parseInt(sel.value, 10) || 0 : sel.value }).catch((err) => alert(err.message));
    };
  });
}

// ---------- actions ----------

async function vote(id, value) {
  const ref = doc(db, "ideas", id, "votes", state.user.uid);
  if (tally(id).mine === value) await deleteDoc(ref); // tap again to undo
  else await setDoc(ref, { value, at: serverTimestamp() });
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-close]")) { e.target.closest("dialog")?.close(); return; }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;
  try {
    if (action === "new") openForm();
    else if (action === "open") openDetail(id);
    else if (action === "vote") { e.stopPropagation(); await vote(id, parseInt(el.dataset.value, 10)); }
    else if (action === "edit") openForm(id);
    else if (action === "delete") {
      if (!confirm("Delete this idea for everyone?")) return;
      detailDialog.close();
      await deleteDoc(doc(db, "ideas", id));
    } else if (action === "delete-comment") {
      if (!confirm("Delete this comment?")) return;
      await deleteDoc(doc(db, "ideas", state.openIdea, "comments", id));
    } else if (action === "remove-member") {
      if (!confirm(`Remove ${memberName(id)} from the trip? They can rejoin with the family code.`)) return;
      await deleteDoc(doc(db, "members", id));
    }
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches?.(".card[data-action=open]")) openDetail(e.target.dataset.id);
});

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  state.view = b.dataset.view;
  try { localStorage.setItem("view", state.view); } catch { /* private mode */ }
  main("");
  render();
});
