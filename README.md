# Daily Potpourri

A daily trivia game for friends, hosted on GitHub Pages.

- One game per day. Up to **100 points** per game.
- Players pick (or create) their name. A running all-time leaderboard tracks everyone.
- Faster correct answers earn more points.
- Archive support for catching up on past games is wired in but will appear once there are multiple games.

## Today's game

**Guess the Chain Restaurant** — 12 rounds, one interior photo per round, type the chain's name.

## Adding a new daily game

1. Drop photos (or whatever the game needs) into `images/`.
2. Create `games/YYYY-MM-DD.json` with this shape:

   ```json
   {
     "date": "YYYY-MM-DD",
     "title": "…",
     "subtitle": "…",
     "secondsPerRound": 20,
     "rounds": [
       { "image": "images/foo.jpg", "answer": "Foo", "aliases": ["fooo", "the foo"] }
     ]
   }
   ```

3. Add an entry to `games/index.json`.
4. Commit + push. GitHub Pages redeploys automatically.

The site loads today's date first; if no game exists for today, it falls back to the most recent dated game listed in `games/index.json`.

## Shared leaderboard (Firebase)

Until you set up Firebase, scores are stored per-device in `localStorage`. To switch to a shared leaderboard across all your friends' devices:

1. Go to <https://console.firebase.google.com/> and create a new project (free Spark plan is fine).
2. Add a **Web App** to the project — copy the `firebaseConfig` it generates.
3. Paste those values into [`js/firebase.js`](js/firebase.js).
4. In the Firebase console, open **Firestore Database → Create database** (production mode, any region near you).
5. Open the **Rules** tab and replace the default with:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /players/{playerId} {
         allow read: if true;
         allow write: if request.resource.data.keys().hasOnly(['name','totalScore','gamesPlayed','lastPlayed'])
                       && request.resource.data.name is string
                       && request.resource.data.name.size() < 30
                       && request.resource.data.totalScore is number
                       && request.resource.data.totalScore <= 100000;
       }
       match /scores/{scoreId} {
         allow read: if true;
         allow write: if request.resource.data.keys().hasOnly(['playerId','playerName','date','score','recordedAt'])
                       && request.resource.data.score is number
                       && request.resource.data.score >= 0
                       && request.resource.data.score <= 100;
       }
     }
   }
   ```

6. Commit and push. Refresh the site — the leaderboard pill will read "shared (Firebase)".

These rules are deliberately permissive on reads/writes (no Firebase Auth) because the game is just for friends. If you want stronger guarantees, add anonymous auth later.

## Local preview

Open `index.html` over a static server (so the `fetch` calls work):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Scoring

`100 / (rounds in the game)` is the per-round maximum (≈ 8.33 for 12 rounds). For a correct guess, you earn:

```
maxPerRound × (0.35 + 0.65 × fractionOfTimeRemaining)
```

So a correct buzzer-beater still nets you ~35% of the round, and an instant correct answer is the full ~8.3 pts.
