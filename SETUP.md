# One-time setup (about 10 minutes)

The app is hosted on GitHub Pages. Sign-in and the shared database use a free Firebase project (the Spark plan; no credit card).
Only the organiser does this.

## 1. Create the Firebase project
1. Go to https://console.firebase.google.com and click **Create a project**.
2. Name it, e.g. `family-trip`. You can switch Google Analytics off. Click **Create project**.

## 2. Turn on Google sign-in
1. Go to **Build → Authentication → Get started**.
2. On **Sign-in method**, choose **Google → Enable**, pick a support email and click **Save**.
3. Go to **Authentication → Settings → Authorized domains → Add domain** and add `pgzq85.github.io`.

## 3. Create the database
1. Go to **Build → Firestore Database → Create database**.
2. Choose location `asia-southeast1 (Singapore)`, or the region nearest your family.
3. Choose **Start in production mode** and click **Create**.
4. Open the **Rules** tab. Replace everything with the contents of [`firestore.rules`](firestore.rules) and click **Publish**.

## 4. Connect the app
1. Click the gear icon, then **Project settings → General → Your apps**, then the **Web** icon (`</>`).
2. Register the app as `family-trip`. Firebase Hosting isn't needed.
3. Copy the `firebaseConfig` values into [`firebase-config.js`](firebase-config.js), then commit and push.
   These values are safe to publish. Access is enforced by the rules and the family code.

## 5. Start the trip
1. Open https://pgzq85.github.io/family-trip/ and **Sign in with Google**. The first person in becomes the **organiser**.
2. Fill in the trip name, first day, 10 days and the three household names. Keep (or change) the generated **family code**.
3. Send the family the link and the code. Each person signs in, enters the code, and picks their name and household.

The organiser can change the code, rename households, change dates and remove people from the **Family** tab.

## Updating the rules later
Paste the new rules into the console's **Rules** tab again. Or, from this folder:
```sh
npx firebase login
npx firebase deploy --only firestore:rules --project <your-project-id>
```
