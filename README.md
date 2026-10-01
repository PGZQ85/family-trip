# Family Trip Planner

A small private web app for 10 people across 3 households to plan a 10-day family holiday together.

- **Suggest**: places to visit, things to do and food to try, with type, place, rough cost, link and notes.
- **Feedback**: 👍 / 👎 votes (one per person) and comments on every idea, with names and household colours.
- **Change**: anyone can edit an idea or set its status (idea → shortlisted → booked, or dropped). Every edit is logged ("Bob changed day: not scheduled → Day 3").
- **10-day plan**: place ideas on Day 1–10, in the morning, afternoon or evening. Shortlisted but unscheduled ideas are listed below.
- **Family**: members grouped by household. The organiser manages the family code, dates and household names, and can reset PINs and remove members.
- Changes from others appear within a few seconds, on phones and computers.

## How it's built
- **Database: SQLite.** The same code runs in two places:
  - **Cloudflare Workers + D1** (Cloudflare's hosted SQLite). Free for a family, always on, HTTPS included. Recommended.
  - **Node + a local SQLite file** (`data/trip.db`), using Node's built-in `node:sqlite`. Good for running on your own computer or server.
- **Login is simple and needs no accounts elsewhere.** You join once with the **family code**, your name, your household and a **PIN**. After that you sign in with name + PIN.
  - PINs are stored only as PBKDF2 hashes.
  - Sessions use HttpOnly cookies.
  - 5 wrong PINs lock that name for 15 minutes, with at most 20 wrong tries a day.
  - Guessing the family code is rate-limited per device.
- There's no build step or framework. `public/` is plain HTML, CSS and JS. `src/api.js` is the API.

```
public/           index.html, app.js, styles.css (front end)
src/api.js        JSON API, shared by both runtimes
src/schema.js     SQLite tables
src/worker.js     Cloudflare entry (D1)
src/server.js     Node entry (SQLite file)
tests/            API tests (in-memory SQLite)
```

## Run locally
Needs Node 22.13 or newer.
```sh
npm start        # http://localhost:8787, data in data/trip.db
npm test         # 12 API tests
```
The first person to open the app sets up the trip and becomes the organiser.

## Deploy free on Cloudflare (recommended)
```sh
npm install
npx wrangler login                      # opens the browser to sign in or create a free Cloudflare account
npx wrangler d1 create family-trip      # copy the printed database_id into wrangler.toml
npx wrangler deploy                     # prints your URL, e.g. https://family-trip.<you>.workers.dev
```
Open the URL and set up the trip. Then send the family the link and the family code.

Backup:
```sh
npx wrangler d1 export family-trip --remote --output backup.sql
```

## Or host it yourself
Run `npm start` on any always-on machine with Node 22.13+. For access from outside your home, put it behind
HTTPS, for example with a free Cloudflare Tunnel or Tailscale Funnel. To back it up, copy `data/trip.db` while the app is stopped.
