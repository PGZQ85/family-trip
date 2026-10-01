# Family Trip Planner

A small private web app for 10 people across 3 households to plan a 10-day family holiday together.

- **Suggest**: places to visit, things to do and food to try, with type, place, rough cost, link and notes.
- **Feedback**: 👍 / 👎 votes (one per person) and comments on every idea, with names and household colours.
- **Change**: anyone can edit an idea or set its status (idea → shortlisted → booked, or dropped). Every edit is logged ("Bob changed day: not scheduled → Day 3").
- **10-day plan**: place ideas on Day 1–10, in the morning, afternoon or evening. Shortlisted but unscheduled ideas are listed below.
- **Family**: members grouped by household. The organiser manages the family code, dates, household names and members.
- Updates appear live for everyone, on phones and computers.

## Setup
**Stack:** a static site on GitHub Pages and Firebase for login and data. Login is Google sign-in plus a family code; the data is in Firestore. There is no server and no build step, and it runs on the free plan.

See **[SETUP.md](SETUP.md)** for the one-time Firebase setup (about 10 minutes, organiser only).

## Security
Everything is enforced in [`firestore.rules`](firestore.rules):
- Only signed-in people who entered the family code can read or write anything.
- You can only vote and comment as yourself.
- Ideas can be edited by anyone, but nobody can change their authorship.
- Only an idea's creator or the organiser can delete it.

## Development
```sh
npm install
npm test        # security rules tests on the Firestore emulator (needs Java 11+)
npm start       # serve locally on http://localhost:5174
```
To try the full app without a Firebase project, start the emulators with
`npx firebase emulators:start --only auth,firestore --project demo-family-trip`.
Then open `http://localhost:5174/?emu=alice`, and `?emu=bob` in another browser profile.
