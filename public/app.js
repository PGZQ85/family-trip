// Family Trip Planner front end. Talks to the JSON API in src/api.js and polls for changes.

const CATEGORIES = {
  attraction: "🎡 Attraction", activity: "🏄 Activity", food: "🍜 Food", shopping: "🛍️ Shopping",
  nature: "🌿 Nature", stay: "🏨 Stay", transport: "🚆 Transport", other: "✨ Other",
};
const STATUSES = { idea: "Idea", shortlist: "Shortlisted", booked: "Booked", dropped: "Dropped" };
const SLOTS = { "": "Any time", morning: "Morning", afternoon: "Afternoon", evening: "Evening" };
const SLOT_ORDER = ["", "morning", "afternoon", "evening"];
const FIELD_LABELS = { title: "title", category: "type", notes: "details", place: "place", link: "link", cost: "cost", status: "status", day: "day", slot: "time" };
const POLL_MS = 4000;

// ---------- helpers ----------

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const options = (map, selected) => Object.entries(map).map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(selected) ? " selected" : ""}>${esc(l)}</option>`).join("");
const initials = (name) => (name || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function dayDate(n) {
  if (!state.trip?.startDate) return "";
  const d = new Date(state.trip.startDate + "T00:00:00");
  d.setDate(d.getDate() + n - 1);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
function dayOptions(selected) {
  const days = { 0: "Not scheduled" };
  for (let i = 1; i <= (state.trip?.days || 10); i++) days[i] = `Day ${i}${dayDate(i) ? " · " + dayDate(i) : ""}`;
  return options(days, selected);
}

function randomCode() {
  const words = ["beach", "mango", "panda", "sunny", "island", "durian", "lantern", "kite", "coconut", "otter", "pebble", "lychee"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

const memberOf = (id) => state.members.get(Number(id));
const memberName = (id) => memberOf(id)?.name || "Someone";
function avatar(m) {
  return `<span class="avatar" style="background:var(--h${m?.household ?? 0})">${esc(initials(m?.name))}</span>`;
}
function hhDot(id) {
  const m = memberOf(id);
  return m ? `<span class="hh hh-${m.household}" title="${esc(state.trip.households[m.household])}"></span>` : "";
}

// ---------- API ----------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.me) { stopPolling(); state.me = null; boot(); }
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  }
  return data;
}

// ---------- state ----------

const state = {
  trip: null, me: null, version: 0,
  members: new Map(), ideas: new Map(),
  view: (() => { try { return localStorage.getItem("view") || "ideas"; } catch { return "ideas"; } })(),
  filter: { q: "", category: "", status: "active", sort: "top" },
  openIdea: null, timer: null,
};

async function load() {
  const s = await api("GET", "/api/state");
  state.version = s.version;
  state.trip = s.trip;
  state.me = s.me;
  state.members = new Map(s.members.map((m) => [m.id, m]));
  state.ideas = new Map(s.ideas.map((i) => [i.id, i]));
  renderHeader();
  renderMe();
  render();
}

function startPolling() {
  stopPolling();
  state.timer = setInterval(async () => {
    if (document.hidden || !state.me) return;
    try {
      const { version } = await api("GET", "/api/version");
      if (version !== state.version) await load();
    } catch { /* offline for a moment: try again next tick */ }
  }, POLL_MS);
}
function stopPolling() { clearInterval(state.timer); state.timer = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.me) load().catch(() => {}); });

// Run a change, then refresh from the server.
async function mutate(fn) {
  try { await fn(); }
  catch (e) { alert(e.message); }
  finally { if (state.me) await load().catch(() => {}); }
}

// ---------- boot + sign in ----------

function main(html) { $("#main").innerHTML = html; }

async function boot() {
  $("#tabs").hidden = true;
  renderMe();
  try {
    const s = await api("GET", "/api/session");
    if (!s.setup) return renderSetup();
    if (!s.signedIn) return renderSignIn();
    await load();
    $("#tabs").hidden = false;
    startPolling();
  } catch (e) {
    main(`<div class="panel"><h2>Can't reach the server</h2><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`);
  }
}

function renderMe() {
  $("#me").innerHTML = state.me
    ? `${avatar(state.me)}<span class="name">${esc(state.me.name)}</span><button class="btn small" id="signout">Sign out</button>`
    : "";
  const so = $("#signout");
  if (so) so.onclick = async () => { stopPolling(); await api("POST", "/api/logout", {}).catch(() => {}); state.me = null; boot(); };
}

function renderHeader() {
  const t = state.trip;
  $("#trip-name").textContent = t?.name || "Family Trip Planner";
  document.title = t?.name ? `${t.name} · Trip Planner` : "Family Trip Planner";
  if (!t) { $("#trip-dates").textContent = ""; return; }
  if (t.startDate) {
    const start = new Date(t.startDate + "T00:00:00"), end = new Date(start);
    end.setDate(end.getDate() + t.days - 1);
    const f = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    $("#trip-dates").textContent = `${t.days} days · ${f(start)} – ${f(end)}`;
  } else $("#trip-dates").textContent = `${t.days} days`;
}

function formError(form, msg) { $(".form-error", form).textContent = msg; }
async function submitting(form, fn) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  formError(form, "");
  try { await fn(); }
  catch (e) { formError(form, e.message); }
  finally { btn.disabled = false; }
}

function renderSignIn() {
  state.trip = null;
  renderHeader();
  main(`<form class="panel" id="signin">
    <h2>Welcome back 👋</h2>
    <p class="lead">Sign in with your name and PIN.</p>
    <label>Your name <input name="name" required maxlength="40" autocomplete="username"></label>
    <label>PIN <input name="pin" type="password" required maxlength="32" inputmode="numeric" autocomplete="current-password"></label>
    <p class="form-error"></p>
    <button class="btn primary" type="submit">Sign in</button>
    <p class="muted" style="margin-top:16px">New here? <button type="button" class="linklike" id="to-join">Join with the family code</button></p>
    <p class="muted" style="font-size:13px">Forgot your PIN? Ask the trip organiser to reset it.</p>
  </form>`);
  const f = $("#signin");
  $("#to-join").onclick = renderJoinCode;
  f.onsubmit = (e) => {
    e.preventDefault();
    submitting(f, async () => { await api("POST", "/api/login", { name: f.name.value, pin: f.pin.value }); await boot(); });
  };
  f.name.focus();
}

function renderJoinCode() {
  main(`<form class="panel" id="join-code">
    <h2>Join the family trip</h2>
    <p>Enter the family code the organiser sent you.</p>
    <label>Family code <input name="code" required maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <p class="form-error"></p>
    <button class="btn primary" type="submit">Next</button>
    <p class="muted" style="margin-top:16px">Already joined? <button type="button" class="linklike" id="to-signin">Sign in</button></p>
  </form>`);
  const f = $("#join-code");
  $("#to-signin").onclick = renderSignIn;
  f.onsubmit = (e) => {
    e.preventDefault();
    submitting(f, async () => {
      const code = f.code.value.trim();
      const info = await api("POST", "/api/check-code", { code });
      renderJoin(code, info);
    });
  };
  f.code.focus();
}

function renderJoin(code, info) {
  main(`<form class="panel" id="join">
    <h2>Join “${esc(info.tripName)}”</h2>
    <label>Your name <input name="name" required maxlength="40" autocomplete="username" placeholder="What the family calls you"></label>
    <label>Your household <select name="household">${info.households.map((n, i) => `<option value="${i}">${esc(n)}</option>`).join("")}</select></label>
    <div class="row">
      <label>Choose a PIN <input name="pin" type="password" required minlength="4" maxlength="32" inputmode="numeric" autocomplete="new-password"></label>
      <label>Repeat PIN <input name="pin2" type="password" required minlength="4" maxlength="32" inputmode="numeric" autocomplete="new-password"></label>
    </div>
    <p class="muted" style="font-size:13px">At least 4 characters. You'll use your name and PIN to sign in on any device.</p>
    <p class="form-error"></p>
    <button class="btn primary" type="submit">Join the trip</button>
  </form>`);
  const f = $("#join");
  f.onsubmit = (e) => {
    e.preventDefault();
    if (f.pin.value !== f.pin2.value) return formError(f, "The two PINs don't match.");
    submitting(f, async () => {
      await api("POST", "/api/join", { code, name: f.name.value, household: Number(f.household.value), pin: f.pin.value });
      await boot();
    });
  };
  f.name.focus();
}

function renderSetup() {
  main(`<form class="panel" id="setup">
    <h2>Set up your family trip</h2>
    <p>You're the first one here, so you'll be the trip organiser. Everyone else joins with the family code below.</p>
    <label>Trip name <input name="tripName" required maxlength="80" value="Family Holiday"></label>
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
      <label>Your name <input name="name" required maxlength="40" autocomplete="username"></label>
      <label>Your household <select name="household"><option value="0">Household 1</option><option value="1">Household 2</option><option value="2">Household 3</option></select></label>
    </div>
    <div class="row">
      <label>Your PIN <input name="pin" type="password" required minlength="4" maxlength="32" inputmode="numeric" autocomplete="new-password"></label>
      <label>Repeat PIN <input name="pin2" type="password" required minlength="4" maxlength="32" inputmode="numeric" autocomplete="new-password"></label>
    </div>
    <p class="form-error"></p>
    <button class="btn primary" type="submit">Create trip</button>
  </form>`);
  const f = $("#setup");
  const syncNames = () => [0, 1, 2].forEach((i) => { f.household.options[i].textContent = f[`h${i}`].value || `Household ${i + 1}`; });
  ["h0", "h1", "h2"].forEach((n) => f[n].addEventListener("input", syncNames));
  f.onsubmit = (e) => {
    e.preventDefault();
    if (f.pin.value !== f.pin2.value) return formError(f, "The two PINs don't match.");
    submitting(f, async () => {
      await api("POST", "/api/setup", {
        tripName: f.tripName.value, startDate: f.startDate.value, days: Number(f.days.value),
        households: [f.h0.value, f.h1.value, f.h2.value], code: f.code.value,
        name: f.name.value, household: Number(f.household.value), pin: f.pin.value,
      });
      await boot();
    });
  };
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
    // Ideas re-renders only its list (keeps the search box); other tabs are left alone while a field is being edited.
    const editing = $("#main").contains(document.activeElement) && document.activeElement.matches("input, select, textarea");
    if (state.view === "ideas") renderIdeas();
    else if (!editing) state.view === "itinerary" ? renderItinerary() : renderFamily();
    if (state.openIdea) renderDetail();
  });
}

function tally(idea) {
  let up = 0, down = 0;
  for (const v of Object.values(idea.votes)) v > 0 ? up++ : down++;
  return { up, down, score: up - down, mine: idea.votes[state.me.id] || 0 };
}

function filteredIdeas() {
  const { q, category, status, sort } = state.filter;
  const needle = q.trim().toLowerCase();
  let list = [...state.ideas.values()].filter((i) =>
    (!category || i.category === category)
    && (status === "all" || (status === "active" ? i.status !== "dropped" : i.status === status))
    && (!needle || `${i.title} ${i.place} ${i.notes} ${memberName(i.createdBy)}`.toLowerCase().includes(needle)));
  const t = (i) => Date.parse(i.createdAt);
  if (sort === "top") list.sort((a, b) => tally(b).score - tally(a).score || tally(b).up - tally(a).up || t(b) - t(a));
  else if (sort === "new") list.sort((a, b) => t(b) - t(a));
  else if (sort === "day") list.sort((a, b) => (a.day || 99) - (b.day || 99) || SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  else if (sort === "unvoted") list = list.filter((i) => !tally(i).mine);
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
    $("#idea-list").innerHTML = `<div class="empty"><p>No ideas yet. Be the first!</p><button class="btn primary" data-action="new">+ Suggest something</button></div>`;
    return;
  }
  if (!list.length) { $("#idea-list").innerHTML = `<div class="empty">Nothing matches these filters.</div>`; return; }
  $("#idea-list").innerHTML = `<div class="grid">${list.map(cardHTML).join("")}</div>`;
}

function voteButtons(i) {
  const t = tally(i);
  return `<button class="vote up${t.mine > 0 ? " on" : ""}" data-action="vote" data-id="${i.id}" data-value="1" title="I like this" aria-pressed="${t.mine > 0}">👍 ${t.up}</button>
    <button class="vote down${t.mine < 0 ? " on" : ""}" data-action="vote" data-id="${i.id}" data-value="-1" title="Not for me" aria-pressed="${t.mine < 0}">👎 ${t.down}</button>`;
}

function cardHTML(i) {
  const t = tally(i);
  return `<article class="card${i.status === "dropped" ? " dropped" : ""}" data-action="open" data-id="${i.id}" tabindex="0">
    <div class="card-top">
      <span class="pill">${esc(CATEGORIES[i.category] || i.category)}</span>
      ${i.status !== "idea" ? `<span class="pill st-${esc(i.status)}">${esc(STATUSES[i.status])}</span>` : ""}
      ${i.day ? `<span class="pill day">🗓️ Day ${i.day}${i.slot ? " · " + esc(SLOTS[i.slot]) : ""}</span>` : ""}
    </div>
    <h3>${esc(i.title)}</h3>
    ${i.place ? `<div class="place">📍 ${esc(i.place)}</div>` : ""}
    <div class="by">${hhDot(i.createdBy)} ${esc(memberName(i.createdBy))} · ${ago(i.createdAt)}${i.cost ? ` · ${esc(i.cost)}` : ""}</div>
    <div class="card-foot">
      ${voteButtons(i)}
      <span class="count">💬 ${i.comments.length}</span>
      <span class="score" title="Likes minus dislikes">${t.score > 0 ? "+" : ""}${t.score}</span>
    </div>
  </article>`;
}

function renderItinerary() {
  const days = state.trip.days || 10;
  const ideas = [...state.ideas.values()].filter((i) => i.status !== "dropped");
  const score = (i) => { const s = tally(i).score; return `${s >= 0 ? "+" : ""}${s}`; };
  const item = (i) => `<button class="slot-item${i.status === "booked" ? " booked" : ""}" data-action="open" data-id="${i.id}">
      ${i.status === "booked" ? "✅ " : ""}${esc(i.title)} <span class="muted">· ${score(i)}</span></button>`;
  let html = `<div class="toolbar"><p class="muted" style="margin:0">Open any idea and pick a day and time to place it here. ✅ = booked.</p></div><div class="days">`;
  for (let d = 1; d <= days; d++) {
    const today = ideas.filter((i) => i.day === d);
    html += `<section class="day-card"><h3>Day ${d} <span class="muted">${esc(dayDate(d))}</span></h3><div class="slots">`;
    for (const slot of ["morning", "afternoon", "evening", ""]) {
      html += `<div class="slot"><div class="slot-name">${SLOTS[slot]}</div>${today.filter((i) => i.slot === slot).map(item).join("")}</div>`;
    }
    html += `</div></section>`;
  }
  html += `</div>`;
  const byScore = (a, b) => tally(b).score - tally(a).score;
  const waiting = ideas.filter((i) => !i.day && i.status === "shortlist").sort(byScore);
  const popular = ideas.filter((i) => !i.day && i.status === "idea" && tally(i).score > 0).sort(byScore);
  html += `<section class="unscheduled"><h3>Shortlisted, not on a day yet</h3>${waiting.length ? `<div class="grid">${waiting.map(cardHTML).join("")}</div>` : `<p class="muted">Nothing waiting.</p>`}</section>`;
  if (popular.length) html += `<section class="unscheduled"><h3>Popular ideas, not on a day yet</h3><div class="grid">${popular.map(cardHTML).join("")}</div></section>`;
  main(html);
}

function renderFamily() {
  const h = state.trip.households;
  const isOwner = state.me.isOwner;
  const active = [...state.members.values()].filter((m) => !m.removed);
  const groups = h.map((name, i) => {
    const ms = active.filter((m) => m.household === i).sort((a, b) => a.name.localeCompare(b.name));
    return `<section class="household"><h3><span class="hh hh-${i}"></span>${esc(name)} <span class="muted">${ms.length}</span></h3>
      ${ms.map((m) => `<div class="member">${avatar(m)} <span>${esc(m.name)}${m.id === state.me.id ? ' <span class="muted">(you)</span>' : ""}${m.isOwner ? ' <span class="muted">· organiser</span>' : ""}</span>
        ${isOwner && m.id !== state.me.id ? `<span class="member-actions"><button class="btn small" data-action="reset-pin" data-id="${m.id}">Reset PIN</button>
          <button class="btn small danger" data-action="remove-member" data-id="${m.id}">Remove</button></span>` : ""}</div>`).join("") || '<p class="muted">No one yet</p>'}
    </section>`;
  }).join("");
  const mine = [...state.ideas.values()].filter((i) => i.createdBy === state.me.id).length;
  const meForm = `<form class="household" id="me-form"><h3>Your details</h3>
      <label>Name <input name="name" required maxlength="40" value="${esc(state.me.name)}"></label>
      <label>Household <select name="household">${h.map((n, i) => `<option value="${i}"${i === state.me.household ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
      <label>New PIN <span class="muted">(leave blank to keep)</span><input name="pin" type="password" minlength="4" maxlength="32" inputmode="numeric" autocomplete="new-password"></label>
      <p class="muted" style="font-size:13px">You've suggested ${mine} idea${mine === 1 ? "" : "s"}.</p>
      <p class="form-error"></p>
      <button class="btn primary small" type="submit">Save</button></form>`;
  const ownerBox = isOwner ? `<section class="household owner-box"><h3>Organiser settings</h3>
      <p class="muted" style="font-size:13px">Send the family this link and code. They tap “Join with the family code”.</p>
      <div class="code-box">${esc(state.trip.code)}</div>
      <p class="muted" style="font-size:13px;text-align:center;margin-top:6px">${esc(location.origin)}</p>
      <form id="trip-form" style="margin-top:12px">
        <label>Trip name <input name="name" required maxlength="80" value="${esc(state.trip.name)}"></label>
        <div class="row">
          <label>First day <input name="startDate" type="date" value="${esc(state.trip.startDate)}"></label>
          <label>Days <input name="days" type="number" min="1" max="30" value="${state.trip.days}"></label>
        </div>
        ${h.map((n, i) => `<label>Household ${i + 1} <input name="h${i}" required maxlength="30" value="${esc(n)}"></label>`).join("")}
        <label>Family code <input name="code" required minlength="6" maxlength="40" value="${esc(state.trip.code)}"></label>
        <p class="muted" style="font-size:12px">Changing the code doesn't remove anyone. It only affects new joiners.</p>
        <p class="form-error"></p>
        <button class="btn primary small" type="submit">Save trip settings</button>
      </form></section>` : "";
  main(`<div class="households">${groups}</div><div class="households" style="margin-top:12px">${meForm}${ownerBox}</div>`);

  const mf = $("#me-form");
  mf.onsubmit = (e) => {
    e.preventDefault();
    submitting(mf, async () => {
      await api("PATCH", "/api/me", { name: mf.name.value, household: Number(mf.household.value), ...(mf.pin.value ? { pin: mf.pin.value } : {}) });
      mf.pin.value = "";
      await load();
      formError(mf, "Saved ✓");
    });
  };
  const tf = $("#trip-form");
  if (tf) tf.onsubmit = (e) => {
    e.preventDefault();
    submitting(tf, async () => {
      await api("PATCH", "/api/trip", {
        name: tf.name.value, startDate: tf.startDate.value, days: Number(tf.days.value),
        households: [tf.h0.value, tf.h1.value, tf.h2.value], code: tf.code.value,
      });
      await load();
      formError(tf, "Saved ✓");
    });
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
  formError(form, "");
  formDialog.showModal();
  form.title.focus();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = {
    title: form.title.value, category: form.category.value, notes: form.notes.value,
    place: form.place.value, link: form.link.value.trim(), cost: form.cost.value,
    status: form.status.value, day: Number(form.day.value) || 0, slot: form.slot.value,
  };
  if (v.link && !safeUrl(v.link)) return formError(form, "Links must start with http:// or https://");
  submitting(form, async () => {
    if (editingId) await api("PATCH", `/api/ideas/${editingId}`, v);
    else await api("POST", "/api/ideas", v);
    formDialog.close();
    await load();
  });
});

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
  // Keep a half-written comment when updates re-render the dialog.
  const draft = $("#comment-text", box)?.value || "";
  const hadFocus = document.activeElement?.id === "comment-text";

  const voters = (val) => Object.entries(i.votes).filter(([, v]) => v === val).map(([id]) => `${hhDot(id)} ${esc(memberName(id))}`).join(", ") || '<span class="muted">nobody yet</span>';
  const history = i.history.slice().reverse();
  const canDelete = i.createdBy === state.me.id || state.me.isOwner;
  const link = safeUrl(i.link);
  let host = "";
  try { host = link ? new URL(link).hostname : ""; } catch { /* malformed link: show nothing */ }

  box.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="card-top"><span class="pill">${esc(CATEGORIES[i.category])}</span>${i.status !== "idea" ? `<span class="pill st-${esc(i.status)}">${esc(STATUSES[i.status])}</span>` : ""}</div>
        <h2>${esc(i.title)}</h2>
        <div class="muted" style="font-size:13px">${hhDot(i.createdBy)} Suggested by ${esc(memberName(i.createdBy))} · ${ago(i.createdAt)}
          ${history.length ? ` · last edited by ${esc(memberName(i.updatedBy))} ${ago(i.updatedAt)}` : ""}</div>
      </div>
      <button class="btn small" data-close aria-label="Close">✕</button>
    </div>
    <div class="facts">
      ${i.place ? `<span>📍 ${esc(i.place)}</span>` : ""}
      ${i.cost ? `<span>💲 ${esc(i.cost)}</span>` : ""}
      ${host ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(host)}</a>` : ""}
    </div>
    ${i.notes ? `<p class="notes">${esc(i.notes)}</p>` : ""}

    <div class="quick">
      <label>Status <select data-quick="status">${options(STATUSES, i.status)}</select></label>
      <label>Day <select data-quick="day">${dayOptions(i.day)}</select></label>
      <label>Time <select data-quick="slot">${options(SLOTS, i.slot)}</select></label>
    </div>

    <div class="card-foot">${voteButtons(i)}
      <span style="margin-left:auto"></span>
      <button class="btn small" data-action="edit" data-id="${i.id}">✏️ Edit</button>
      ${canDelete ? `<button class="btn small danger" data-action="delete" data-id="${i.id}">Delete</button>` : ""}
    </div>
    <div class="voters" style="margin-top:8px"><span>👍 ${voters(1)}</span></div>
    <div class="voters"><span>👎 ${voters(-1)}</span></div>

    <section class="section">
      <h3>Comments (${i.comments.length})</h3>
      <ul class="comments">${i.comments.map((c) => `<li>
        <div class="who">${hhDot(c.by)} <b>${esc(memberName(c.by))}</b> · ${ago(c.at)}
          ${c.by === state.me.id || state.me.isOwner ? `<button class="linklike" data-action="delete-comment" data-id="${c.id}">delete</button>` : ""}</div>
        <p>${esc(c.text)}</p></li>`).join("") || '<li class="muted">No comments yet.</li>'}</ul>
      <form class="comment-form" id="comment-form">
        <textarea id="comment-text" rows="2" maxlength="1000" placeholder="Add a comment or suggest a change…" required></textarea>
        <button class="btn primary" type="submit">Post</button>
      </form>
    </section>

    ${history.length ? `<section class="section"><h3>Changes</h3><ul class="history">${history.map((h) =>
      `<li>${hhDot(h.by)} <b>${esc(memberName(h.by))}</b> ${Object.entries(h.changes).map(([f, c]) => describeChange(f, c)).join("; ")} · ${ago(h.at)}</li>`).join("")}</ul></section>` : ""}
  `;

  const ta = $("#comment-text", box);
  ta.value = draft;
  if (hadFocus) { ta.focus(); ta.setSelectionRange(draft.length, draft.length); }
  $("#comment-form", box).onsubmit = (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    mutate(() => api("POST", `/api/ideas/${i.id}/comments`, { text }));
  };
  box.querySelectorAll("[data-quick]").forEach((sel) => {
    sel.onchange = () => {
      const k = sel.dataset.quick;
      mutate(() => api("PATCH", `/api/ideas/${i.id}`, { [k]: k === "day" ? Number(sel.value) || 0 : sel.value }));
    };
  });
}

// ---------- actions ----------

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) { e.target.closest("dialog")?.close(); return; }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action, id = Number(el.dataset.id);
  if (action === "new") openForm();
  else if (action === "open") openDetail(id);
  else if (action === "edit") openForm(id);
  else if (action === "vote") {
    const value = Number(el.dataset.value);
    mutate(() => api("PUT", `/api/ideas/${id}/vote`, { value: tally(state.ideas.get(id)).mine === value ? 0 : value })); // tap again to undo
  } else if (action === "delete") {
    if (!confirm("Delete this idea for everyone?")) return;
    detailDialog.close();
    mutate(() => api("DELETE", `/api/ideas/${id}`, {}));
  } else if (action === "delete-comment") {
    if (!confirm("Delete this comment?")) return;
    mutate(() => api("DELETE", `/api/comments/${id}`, {}));
  } else if (action === "remove-member") {
    if (!confirm(`Remove ${memberName(id)} from the trip? They can rejoin with the family code.`)) return;
    mutate(() => api("DELETE", `/api/members/${id}`, {}));
  } else if (action === "reset-pin") {
    const pin = prompt(`New PIN for ${memberName(id)} (at least 4 characters). Tell them the new PIN; they can change it later.`);
    if (pin) mutate(async () => { await api("POST", `/api/members/${id}/pin`, { pin }); alert(`PIN for ${memberName(id)} has been reset.`); });
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches?.(".card[data-action=open]")) openDetail(Number(e.target.dataset.id));
});

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  state.view = b.dataset.view;
  try { localStorage.setItem("view", state.view); } catch { /* private mode */ }
  main("");
  render();
});

boot();
