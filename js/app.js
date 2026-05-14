import { FIREBASE_ENABLED, getDb } from "./firebase.js";

const LS_PLAYER_KEY = "dt:currentPlayer";
const LS_PLAYERS_KEY = "dt:players";          // [{ id, name, totalScore, gamesPlayed, playedDates: [] }]
const LS_LEADERBOARD_KEY = "dt:leaderboard";  // mirror for offline fallback
const MAX_TOTAL_POINTS = 100;

// ---------- utilities ----------
function $(id) { return document.getElementById(id); }
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}
function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10);
}

// ---------- storage ----------
function loadPlayers() {
  try { return JSON.parse(localStorage.getItem(LS_PLAYERS_KEY)) || []; }
  catch { return []; }
}
function savePlayers(players) {
  localStorage.setItem(LS_PLAYERS_KEY, JSON.stringify(players));
}
function getCurrentPlayerId() {
  return localStorage.getItem(LS_PLAYER_KEY);
}
function setCurrentPlayerId(id) {
  localStorage.setItem(LS_PLAYER_KEY, id);
}
function getCurrentPlayer() {
  const id = getCurrentPlayerId();
  if (!id) return null;
  return loadPlayers().find(p => p.id === id) || null;
}

// ---------- Firebase data layer ----------
async function fbUpsertPlayer(player) {
  if (!FIREBASE_ENABLED) return;
  try {
    const db = await getDb();
    const { doc, setDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
    await setDoc(doc(db, "players", player.id), {
      name: player.name,
      totalScore: player.totalScore,
      gamesPlayed: player.gamesPlayed,
      lastPlayed: serverTimestamp()
    }, { merge: true });
  } catch (e) { console.warn("Firebase upsert failed:", e); }
}

async function fbRecordGame(playerId, playerName, gameDate, score) {
  if (!FIREBASE_ENABLED) return;
  try {
    const db = await getDb();
    const { doc, setDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
    // One score per player per game (overwrite-safe via composite id).
    await setDoc(doc(db, "scores", `${playerId}_${gameDate}`), {
      playerId, playerName, date: gameDate, score,
      recordedAt: serverTimestamp()
    });
  } catch (e) { console.warn("Firebase record game failed:", e); }
}

async function fbFetchLeaderboard() {
  if (!FIREBASE_ENABLED) return null;
  try {
    const db = await getDb();
    const { collection, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
    const snap = await getDocs(collection(db, "players"));
    const rows = [];
    snap.forEach(d => {
      const v = d.data();
      rows.push({
        id: d.id,
        name: v.name || "Unknown",
        totalScore: v.totalScore || 0,
        gamesPlayed: v.gamesPlayed || 0
      });
    });
    return rows;
  } catch (e) {
    console.warn("Firebase fetch leaderboard failed:", e);
    return null;
  }
}

async function fbFetchAllPlayers() {
  return fbFetchLeaderboard();
}

// ---------- game state ----------
let game = null;        // loaded game JSON
let roundIdx = 0;
let roundStartedAt = 0;
let timerRAF = null;
let roundEnded = false;
let totalScore = 0;
const breakdown = [];   // [{ answer, guess, correct, points, elapsed }]

// ---------- screens ----------
function show(screenId) {
  ["player-screen","intro-screen","game-screen","orbits-screen","results-screen"].forEach(id => {
    $(id).classList.add("hidden");
  });
  $(screenId).classList.remove("hidden");
}

// ---------- player selection ----------
async function renderPlayerScreen() {
  // Merge local players + any from Firebase so returning friends see each other's names.
  const localPlayers = loadPlayers();
  let players = localPlayers;
  if (FIREBASE_ENABLED) {
    const remote = await fbFetchAllPlayers();
    if (remote && remote.length) {
      const byId = new Map(localPlayers.map(p => [p.id, p]));
      remote.forEach(r => byId.set(r.id, { ...byId.get(r.id), ...r, playedDates: byId.get(r.id)?.playedDates || [] }));
      players = [...byId.values()];
      savePlayers(players);
    }
  }
  const list = $("player-list");
  list.innerHTML = "";
  const visiblePlayers = players.filter(p => !p.name?.startsWith("_"));
  if (!visiblePlayers.length) {
    list.innerHTML = `<p class="muted small">No players yet — add yourself below.</p>`;
  } else {
    visiblePlayers
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(p => {
        const btn = document.createElement("button");
        btn.textContent = p.name;
        btn.onclick = () => selectPlayer(p.id);
        list.appendChild(btn);
      });
  }
  show("player-screen");
  renderLeaderboard();
}

function selectPlayer(id) {
  setCurrentPlayerId(id);
  renderTopbar();
  goToIntro();
}

$("new-player-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const nameRaw = $("new-player-name").value.trim();
  if (!nameRaw) return;
  const players = loadPlayers();
  const exists = players.find(p => p.name.toLowerCase() === nameRaw.toLowerCase());
  if (exists) {
    selectPlayer(exists.id);
    return;
  }
  const player = { id: uid(), name: nameRaw, totalScore: 0, gamesPlayed: 0, playedDates: [] };
  players.push(player);
  savePlayers(players);
  fbUpsertPlayer(player);
  selectPlayer(player.id);
});

$("switch-player-btn").addEventListener("click", () => {
  localStorage.removeItem(LS_PLAYER_KEY);
  renderTopbar();
  renderPlayerScreen();
});

// ---------- topbar ----------
function renderTopbar() {
  const player = getCurrentPlayer();
  const pill = $("player-pill");
  const sw = $("switch-player-btn");
  if (player) {
    pill.textContent = `Playing as ${player.name}`;
    pill.classList.remove("hidden");
    sw.classList.remove("hidden");
  } else {
    pill.classList.add("hidden");
    sw.classList.add("hidden");
  }
}

// ---------- intro ----------
async function goToIntro() {
  $("intro-title").textContent = game.title || "Today's Game";
  $("intro-desc").textContent = game.subtitle || "";
  $("game-subtitle").textContent = game.title || "";
  const roundCount = (game.rounds || []).length;
  const rulesByType = {
    orbits: [
      `${roundCount} planets to place. Up to <strong>100 points</strong> total.`,
      "Closer to the real orbital distance = more points.",
      "Click the canvas to set each orbit, nudge to fine-tune, then lock it in."
    ],
    default: [
      `${roundCount} rounds. Up to <strong>100 points</strong> total.`,
      "Faster guesses earn more points.",
      "Type your answer and hit enter."
    ]
  };
  const rules = rulesByType[game.type] || rulesByType.default;
  $("intro-rules").innerHTML = rules.map(r => `<li>${r}</li>`).join("");
  const player = getCurrentPlayer();
  const note = $("already-played-note");
  if (player && player.playedDates && player.playedDates.includes(game.date)) {
    note.textContent = "You've already played today's game — playing again won't add to your all-time score.";
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
  }
  show("intro-screen");
}

$("start-btn").addEventListener("click", () => startGame());

// ---------- game flow ----------
function startGame() {
  roundIdx = 0;
  totalScore = 0;
  breakdown.length = 0;
  if (game.type === "orbits") {
    orbitsLocked.length = 0;
    show("orbits-screen");
    initOrbitsCanvas();
    startOrbitsRound();
  } else {
    show("game-screen");
    loadRound();
  }
}

function loadRound() {
  roundEnded = false;
  const r = game.rounds[roundIdx];
  $("round-indicator").textContent = `Round ${roundIdx + 1} of ${game.rounds.length}`;
  $("score-indicator").textContent = `Score: ${Math.round(totalScore)}`;
  $("round-image").src = r.image;
  $("guess-input").value = "";
  $("guess-input").disabled = false;
  $("feedback").textContent = "";
  $("feedback").className = "feedback";
  $("guess-input").focus();
  roundStartedAt = performance.now();
  startTimer();
}

function startTimer() {
  const totalMs = (game.secondsPerRound || 20) * 1000;
  const fill = $("timer-fill");
  function frame() {
    if (roundEnded) return;
    const elapsed = performance.now() - roundStartedAt;
    const remaining = Math.max(0, totalMs - elapsed);
    fill.style.transform = `scaleX(${remaining / totalMs})`;
    if (remaining <= 0) {
      endRound({ correct: false, guess: "", timedOut: true });
      return;
    }
    timerRAF = requestAnimationFrame(frame);
  }
  timerRAF = requestAnimationFrame(frame);
}

function stopTimer() {
  if (timerRAF) cancelAnimationFrame(timerRAF);
  timerRAF = null;
}

$("guess-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (roundEnded) return;
  const guess = $("guess-input").value.trim();
  if (!guess) return;
  const r = game.rounds[roundIdx];
  const accepted = [normalize(r.answer), ...(r.aliases || []).map(normalize)];
  const isCorrect = accepted.includes(normalize(guess));
  endRound({ correct: isCorrect, guess });
});

function endRound({ correct, guess, timedOut }) {
  if (roundEnded) return;
  roundEnded = true;
  stopTimer();
  const elapsedMs = performance.now() - roundStartedAt;
  const totalMs = (game.secondsPerRound || 20) * 1000;
  const r = game.rounds[roundIdx];
  const maxPerRound = MAX_TOTAL_POINTS / game.rounds.length;
  let points = 0;
  if (correct) {
    const remainingFrac = Math.max(0, (totalMs - elapsedMs) / totalMs);
    // Quick guesses get nearly full points; we keep a small floor so a correct slow answer is still rewarded.
    points = maxPerRound * (0.35 + 0.65 * remainingFrac);
  }
  totalScore += points;
  breakdown.push({
    answer: r.answer,
    guess: timedOut ? "(timed out)" : guess,
    correct,
    points,
    elapsedSec: elapsedMs / 1000
  });

  $("guess-input").disabled = true;
  const fb = $("feedback");
  if (correct) {
    fb.textContent = `Correct! +${points.toFixed(1)} pts (${(elapsedMs/1000).toFixed(1)}s)`;
    fb.className = "feedback good";
  } else if (timedOut) {
    fb.textContent = `Time's up. Answer: ${r.answer}`;
    fb.className = "feedback bad";
  } else {
    fb.textContent = `Nope — answer: ${r.answer}`;
    fb.className = "feedback bad";
  }
  $("score-indicator").textContent = `Score: ${Math.round(totalScore)}`;

  setTimeout(() => {
    roundIdx++;
    if (roundIdx >= game.rounds.length) finishGame();
    else loadRound();
  }, 1600);
}

async function finishGame() {
  const finalScore = Math.min(MAX_TOTAL_POINTS, Math.round(totalScore));
  $("final-score").textContent = finalScore;
  const correctCount = breakdown.filter(b => b.correct).length;
  $("results-summary").textContent = `You got ${correctCount} of ${game.rounds.length} right.`;
  const list = $("round-breakdown");
  list.innerHTML = "";
  breakdown.forEach((b, i) => {
    const row = document.createElement("div");
    row.className = `row-item ${b.correct ? "correct" : "wrong"}`;
    row.innerHTML = `
      <span>${i + 1}. ${b.answer}</span>
      <span>${b.correct ? `+${b.points.toFixed(1)}` : "0"} <small>(${b.elapsedSec.toFixed(1)}s)</small></span>
    `;
    list.appendChild(row);
  });

  // Save to player's all-time totals, but only once per game date.
  const player = getCurrentPlayer();
  if (player) {
    const already = player.playedDates && player.playedDates.includes(game.date);
    if (!already) {
      player.totalScore = (player.totalScore || 0) + finalScore;
      player.gamesPlayed = (player.gamesPlayed || 0) + 1;
      player.playedDates = [...(player.playedDates || []), game.date];
      const players = loadPlayers().map(p => p.id === player.id ? player : p);
      savePlayers(players);
      fbUpsertPlayer(player);
      fbRecordGame(player.id, player.name, game.date, finalScore);
    }
  }

  show("results-screen");
  renderLeaderboard();
}

$("view-leaderboard-btn").addEventListener("click", () => {
  document.getElementById("leaderboard").scrollIntoView({ behavior: "smooth" });
});

// ---------- leaderboard ----------
async function renderLeaderboard() {
  const me = getCurrentPlayer();
  let rows = loadPlayers();
  let source = "local device";
  if (FIREBASE_ENABLED) {
    source = "shared (Firebase)";
    const remote = await fbFetchLeaderboard();
    if (remote) {
      rows = remote;
      localStorage.setItem(LS_LEADERBOARD_KEY, JSON.stringify(remote));
    } else {
      const cached = localStorage.getItem(LS_LEADERBOARD_KEY);
      if (cached) rows = JSON.parse(cached);
    }
  }
  rows = rows
    .filter(p => !p.name?.startsWith("_"))
    .filter(p => p.gamesPlayed > 0 || (p.totalScore || 0) > 0)
    .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
  $("leaderboard-source").textContent = source;
  const ol = $("leaderboard-list");
  ol.innerHTML = "";
  if (!rows.length) {
    ol.innerHTML = `<li><span class="rank">—</span><span>No scores yet. Be the first!</span><span class="total">0</span></li>`;
    return;
  }
  rows.forEach((p, i) => {
    const li = document.createElement("li");
    if (me && p.id === me.id) li.classList.add("you");
    li.innerHTML = `
      <span class="rank">#${i + 1}</span>
      <span>${escapeHtml(p.name)}<span class="played">${p.gamesPlayed || 0} game${(p.gamesPlayed||0) === 1 ? "" : "s"}</span></span>
      <span class="total">${p.totalScore || 0}</span>
    `;
    ol.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

// ---------- boot ----------
async function loadTodaysGame() {
  // Optional ?date=YYYY-MM-DD override for previewing future games.
  const params = new URLSearchParams(location.search);
  const override = params.get("date");
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) {
    const res = await fetch(`games/${override}.json`, { cache: "no-store" });
    if (res.ok) return await res.json();
  }
  // Prefer today's date, fall back to the most recent file listed in games/index.json.
  const today = todayLocalISO();
  try {
    const res = await fetch(`games/${today}.json`, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {}
  try {
    const idxRes = await fetch("games/index.json", { cache: "no-store" });
    if (idxRes.ok) {
      const idx = await idxRes.json();
      const sorted = [...idx.games].sort((a, b) => b.date.localeCompare(a.date));
      const latest = sorted[0];
      if (latest) {
        const res = await fetch(`games/${latest.date}.json`, { cache: "no-store" });
        if (res.ok) return await res.json();
      }
    }
  } catch {}
  throw new Error("No game found.");
}

async function backfillLocalPlayersToFirebase() {
  if (!FIREBASE_ENABLED) return;
  const remote = await fbFetchAllPlayers();
  if (!remote) return;
  const remoteIds = new Set(remote.map(p => p.id));
  const locals = loadPlayers().filter(p => !remoteIds.has(p.id) && (p.totalScore > 0 || p.gamesPlayed > 0));
  for (const p of locals) {
    await fbUpsertPlayer(p);
  }
}

// ---------- orbits game ----------
const orbitsLocked = []; // [{ planet, drawnAu, actualAu, pts }]
let orbitsCanvas = null;
let orbitsCtx = null;
let orbitsCx = 0, orbitsCy = 0;
let orbitsScale = 1; // px per AU
let orbitsStars = [];
let orbitsDraftAu = 0;
let orbitsHoverAu = 0;
let orbitsRoundLocked = false; // true while showing feedback between rounds

function initOrbitsCanvas() {
  orbitsCanvas = $("orbit-canvas");
  orbitsCtx = orbitsCanvas.getContext("2d");
  const wrap = orbitsCanvas.parentElement;
  const padding = 20;
  const targetSize = Math.min(600, wrap.clientWidth - padding);
  const dpr = window.devicePixelRatio || 1;
  orbitsCanvas.style.width = targetSize + "px";
  orbitsCanvas.style.height = targetSize + "px";
  orbitsCanvas.width = targetSize * dpr;
  orbitsCanvas.height = targetSize * dpr;
  orbitsCtx.scale(dpr, dpr);
  orbitsCx = targetSize / 2;
  orbitsCy = targetSize / 2;
  const neptune = (game.references || []).find(r => r.planet === "Neptune");
  const maxAu = neptune ? neptune.distanceAu : 30;
  orbitsScale = (targetSize / 2 * 0.94) / maxAu;
  orbitsStars = [];
  for (let i = 0; i < 100; i++) {
    orbitsStars.push({
      x: Math.random() * targetSize,
      y: Math.random() * targetSize,
      r: Math.random() * 1.3 + 0.2,
      a: Math.random() * 0.5 + 0.2
    });
  }
  orbitsCanvas.onclick = onOrbitsCanvasClick;
  orbitsCanvas.onmousemove = onOrbitsCanvasMove;
  orbitsCanvas.onmouseleave = () => { orbitsHoverAu = 0; renderOrbitsCanvas(); };
}

function distToCenter(clientX, clientY) {
  const rect = orbitsCanvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const dx = x - orbitsCx, dy = y - orbitsCy;
  return Math.sqrt(dx * dx + dy * dy);
}

function onOrbitsCanvasClick(e) {
  if (orbitsRoundLocked) return;
  const distPx = distToCenter(e.clientX, e.clientY);
  orbitsDraftAu = Math.max(0, distPx / orbitsScale);
  $("orbits-submit-btn").disabled = orbitsDraftAu <= 0;
  $("orbits-nudge-down").disabled = orbitsDraftAu <= 0;
  $("orbits-nudge-up").disabled = orbitsDraftAu <= 0;
  updateOrbitsReadout();
  renderOrbitsCanvas();
}

function onOrbitsCanvasMove(e) {
  if (orbitsRoundLocked) return;
  const distPx = distToCenter(e.clientX, e.clientY);
  orbitsHoverAu = distPx / orbitsScale;
  renderOrbitsCanvas();
}

function renderOrbitsCanvas(extra) {
  const ctx = orbitsCtx;
  const w = parseFloat(orbitsCanvas.style.width);
  const h = parseFloat(orbitsCanvas.style.height);
  ctx.fillStyle = "#0a0d18";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#ccd";
  orbitsStars.forEach(s => {
    ctx.globalAlpha = s.a;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  (game.references || []).forEach(ref => {
    const r = ref.distanceAu * orbitsScale;
    ctx.strokeStyle = "rgba(200,210,240,0.95)";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(orbitsCx, orbitsCy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // Label placed above the top of the ring, centered, never clipped at the right edge.
    ctx.fillStyle = "rgba(220,225,245,0.95)";
    ctx.font = "11px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(ref.planet, orbitsCx, orbitsCy - r - 4);
  });

  orbitsLocked.forEach(l => {
    const r = l.drawnAu * orbitsScale;
    ctx.strokeStyle = "rgba(255,181,71,0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(orbitsCx, orbitsCy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,181,71,0.85)";
    ctx.font = "11px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(l.planet, orbitsCx, orbitsCy + r + 3);
  });

  if (!orbitsRoundLocked && orbitsHoverAu > 0) {
    const r = orbitsHoverAu * orbitsScale;
    ctx.strokeStyle = "rgba(255,181,71,0.20)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(orbitsCx, orbitsCy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (orbitsDraftAu > 0) {
    const r = orbitsDraftAu * orbitsScale;
    ctx.strokeStyle = orbitsRoundLocked ? "rgba(255,122,89,0.95)" : "#ffb547";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(orbitsCx, orbitsCy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (extra && extra.correctAu) {
    const r = extra.correctAu * orbitsScale;
    ctx.strokeStyle = "rgba(74,222,128,0.95)";
    ctx.setLineDash([7, 4]);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(orbitsCx, orbitsCy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Sun — kept small so Mercury's tiny orbit stays visible at this scale.
  const sunGlowRadius = 9;
  const sunGrad = ctx.createRadialGradient(orbitsCx, orbitsCy, 0, orbitsCx, orbitsCy, sunGlowRadius);
  sunGrad.addColorStop(0, "#fff3a0");
  sunGrad.addColorStop(0.55, "#ffb547");
  sunGrad.addColorStop(1, "rgba(255,122,89,0)");
  ctx.fillStyle = sunGrad;
  ctx.beginPath();
  ctx.arc(orbitsCx, orbitsCy, sunGlowRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff8d0";
  ctx.beginPath();
  ctx.arc(orbitsCx, orbitsCy, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function updateOrbitsReadout() {
  const au = orbitsDraftAu;
  $("orbits-readout").textContent = au > 0
    ? `Your orbit: ${au.toFixed(2)} AU  (1 AU = Earth–Sun distance)`
    : "Click in the canvas to set the orbital radius.";
}

function scoreOrbit(drawnAu, actualAu, maxPts) {
  if (drawnAu <= 0) return 0;
  const err = Math.abs(drawnAu - actualAu) / actualAu;
  if (err <= 0.10) return maxPts;
  if (err >= 0.80) return 0;
  return maxPts * (1 - (err - 0.10) / 0.70);
}

function startOrbitsRound() {
  orbitsDraftAu = 0;
  orbitsHoverAu = 0;
  orbitsRoundLocked = false;
  const r = game.rounds[roundIdx];
  $("orbits-target-name").textContent = r.planet;
  $("orbits-round-indicator").textContent = `Round ${roundIdx + 1} of ${game.rounds.length}`;
  $("orbits-score-indicator").textContent = `Score: ${Math.round(totalScore)}`;
  $("orbits-feedback").textContent = "";
  $("orbits-feedback").className = "feedback";
  $("orbits-submit-btn").disabled = true;
  $("orbits-nudge-down").disabled = true;
  $("orbits-nudge-up").disabled = true;
  updateOrbitsReadout();
  renderOrbitsCanvas();
}

function nudgeOrbit(delta) {
  if (orbitsRoundLocked) return;
  orbitsDraftAu = Math.max(0, orbitsDraftAu + delta);
  updateOrbitsReadout();
  renderOrbitsCanvas();
}

$("orbits-nudge-down").addEventListener("click", () => nudgeOrbit(-0.1));
$("orbits-nudge-up").addEventListener("click", () => nudgeOrbit(0.1));

$("orbits-submit-btn").addEventListener("click", () => {
  if (orbitsRoundLocked || orbitsDraftAu <= 0) return;
  orbitsRoundLocked = true;
  const r = game.rounds[roundIdx];
  const maxPerRound = MAX_TOTAL_POINTS / game.rounds.length;
  const pts = scoreOrbit(orbitsDraftAu, r.distanceAu, maxPerRound);
  orbitsLocked.push({ planet: r.planet, drawnAu: orbitsDraftAu, actualAu: r.distanceAu, pts });
  totalScore += pts;
  breakdown.push({
    answer: `${r.planet} at ${r.distanceAu.toFixed(2)} AU`,
    guess: `${orbitsDraftAu.toFixed(2)} AU`,
    correct: pts > 0,
    points: pts,
    elapsedSec: 0
  });
  renderOrbitsCanvas({ correctAu: r.distanceAu });
  $("orbits-score-indicator").textContent = `Score: ${Math.round(totalScore)}`;
  $("orbits-submit-btn").disabled = true;
  $("orbits-nudge-down").disabled = true;
  $("orbits-nudge-up").disabled = true;
  const fb = $("orbits-feedback");
  const errPct = Math.abs(orbitsDraftAu - r.distanceAu) / r.distanceAu * 100;
  if (pts >= maxPerRound * 0.99) {
    fb.textContent = `Bullseye! ${r.planet} is at ${r.distanceAu.toFixed(2)} AU. +${pts.toFixed(1)} pts.`;
    fb.className = "feedback good";
  } else if (pts > 0) {
    fb.textContent = `${r.planet} is at ${r.distanceAu.toFixed(2)} AU — you were off by ${errPct.toFixed(0)}%. +${pts.toFixed(1)} pts.`;
    fb.className = "feedback";
  } else {
    fb.textContent = `Way off — ${r.planet} is at ${r.distanceAu.toFixed(2)} AU.`;
    fb.className = "feedback bad";
  }
  setTimeout(() => {
    roundIdx++;
    if (roundIdx >= game.rounds.length) finishGame();
    else startOrbitsRound();
  }, 2200);
});

// ---------- boot ----------
(async function init() {
  try {
    game = await loadTodaysGame();
  } catch (e) {
    document.body.innerHTML = `<main style="padding:40px;text-align:center"><h2>Couldn't load today's trivia.</h2><p class="muted">${e.message}</p></main>`;
    return;
  }
  renderTopbar();
  await backfillLocalPlayersToFirebase();
  const player = getCurrentPlayer();
  if (player) {
    goToIntro();
    renderLeaderboard();
  } else {
    renderPlayerScreen();
  }
})();
