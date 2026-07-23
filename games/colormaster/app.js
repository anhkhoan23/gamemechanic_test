import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  onValue,
  onDisconnect,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";
import { firebaseConfig } from "../../firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ---- Game constants (match the PRD) ----
const TOTAL_ROUNDS = 5;
const MEMORIZE_SECONDS = 10;
const GUESS_SECONDS = 30;
const RESULT_SECONDS = 5;
const D_MAX = Math.sqrt(255 * 255 * 3); // ~441.673

// ---- View management ----
const views = {
  menu: document.getElementById('view-menu'),
  waiting: document.getElementById('view-waiting'),
  memorize: document.getElementById('view-memorize'),
  guess: document.getElementById('view-guess'),
  result: document.getElementById('view-result'),
  summary: document.getElementById('view-summary'),
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.remove('active'));
  views[name].classList.add('active');
}

// ---- State ----
let myUid = null;
let myName = '';
let roomId = null;
let isHost = false;
let serverOffset = 0;
let currentColor = '#888888';
let picker = null;
let hasSubmitted = false;
let currentRoom = null; // latest snapshot value, used by the submit handler
let lastRenderedKey = null; // guards against re-running one-time setup (timers, picker init) on every DB snapshot
let hostTimer = null; // host-only: scheduled phase transition
let progressRAF = null;

function nowServer() {
  return Date.now() + serverOffset;
}

onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
  serverOffset = snap.val() || 0;
});

// ---- Auth (anonymous) ----
const menuError = document.getElementById('menu-error');

signInAnonymously(auth).catch((err) => {
  menuError.textContent = 'Không thể kết nối Firebase Auth: ' + err.message;
});

onAuthStateChanged(auth, (user) => {
  if (user) myUid = user.uid;
});

function randomRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function randomHexColor() {
  const r = Math.floor(Math.random() * 256);
  const g = Math.floor(Math.random() * 256);
  const b = Math.floor(Math.random() * 256);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

function calcAccuracy(targetHex, guessHex) {
  const t = hexToRgb(targetHex);
  const g = hexToRgb(guessHex);
  const d = Math.sqrt((t.r - g.r) ** 2 + (t.g - g.g) ** 2 + (t.b - g.b) ** 2);
  const accuracy = (1 - d / D_MAX) * 100;
  return Math.max(0, Math.round(accuracy * 100) / 100);
}

// ---- Menu view ----
const inputName = document.getElementById('input-name');
const inputRoomCode = document.getElementById('input-room-code');

document.getElementById('btn-create-room').addEventListener('click', async () => {
  menuError.textContent = '';
  if (!myUid) { menuError.textContent = 'Đang kết nối, vui lòng thử lại sau 1 giây.'; return; }
  myName = inputName.value.trim() || 'Player 1';
  roomId = randomRoomId();

  await set(ref(db, `rooms/${roomId}`), {
    hostUid: myUid,
    players: { [myUid]: { name: myName } },
    scores: { [myUid]: 0 },
    status: 'waiting',
    round: 0,
    phase: '',
    createdAt: serverTimestamp(),
  });

  onDisconnect(ref(db, `rooms/${roomId}/players/${myUid}`)).remove();

  document.getElementById('waiting-room-code').textContent = roomId;
  showView('waiting');
  subscribeToRoom(roomId);
});

document.getElementById('btn-join-room').addEventListener('click', async () => {
  menuError.textContent = '';
  if (!myUid) { menuError.textContent = 'Đang kết nối, vui lòng thử lại sau 1 giây.'; return; }
  myName = inputName.value.trim() || 'Player 2';
  const code = inputRoomCode.value.trim().toUpperCase();
  if (!code) { menuError.textContent = 'Vui lòng nhập mã phòng.'; return; }

  const roomSnap = await get(ref(db, `rooms/${code}`));
  const room = roomSnap.val();
  if (!room) { menuError.textContent = 'Phòng không tồn tại.'; return; }
  if (room.players && Object.keys(room.players).length >= 2) {
    menuError.textContent = 'Phòng đã đủ người.';
    return;
  }

  roomId = code;
  await update(ref(db, `rooms/${roomId}`), {
    [`players/${myUid}`]: { name: myName },
    [`scores/${myUid}`]: 0,
  });

  onDisconnect(ref(db, `rooms/${roomId}/players/${myUid}`)).remove();

  subscribeToRoom(roomId);
});

// ---- Room subscription & rendering ----
function subscribeToRoom(id) {
  onValue(ref(db, `rooms/${id}`), (snap) => handleRoomUpdate(snap.val()));
}

function handleRoomUpdate(room) {
  currentRoom = room;

  if (!room) {
    alert('Phòng đã đóng hoặc đối thủ đã rời đi.');
    window.location.reload();
    return;
  }

  isHost = myUid === room.hostUid;
  const players = room.players || {};
  const playerCount = Object.keys(players).length;

  if (room.status === 'waiting') {
    showView('waiting');
    document.getElementById('waiting-room-code').textContent = roomId;
    if (playerCount === 2 && isHost) startGame(room);
    return;
  }

  // Mid-game disconnect: someone left.
  if (room.status !== 'gameover' && playerCount < 2) {
    alert('Đối thủ đã rời phòng. Trò chơi kết thúc.');
    window.location.reload();
    return;
  }

  if (room.status === 'playing') {
    renderPlayingState(room);
  } else if (room.status === 'gameover') {
    renderGameOver(room);
  }
}

function renderPlayingState(room) {
  const round = room.round;
  const phase = room.phase;
  const target = room.colors[round - 1];
  const key = `${round}-${phase}`;
  const isNewKey = key !== lastRenderedKey;
  lastRenderedKey = key;

  if (phase === 'memorize') {
    if (isNewKey) hasSubmitted = false;
    document.getElementById('memorize-round').textContent = round;
    document.getElementById('memorize-target').style.background = target;
    showView('memorize');
    animateProgress('memorize-progress', room.phaseEndsAt, MEMORIZE_SECONDS);

    if (isHost && isNewKey) {
      scheduleHostTransition(room.phaseEndsAt, () => startGuessPhase());
    }
  } else if (phase === 'guess') {
    document.getElementById('guess-round').textContent = round;

    if (isNewKey) {
      currentColor = '#888888';
      updatePreview(currentColor);
      setupPicker();
      document.getElementById('guess-waiting-text').classList.add('hidden');
      document.getElementById('btn-submit-color').disabled = false;
      document.getElementById('guess-hex').disabled = false;
    }

    showView('guess');
    animateProgress('guess-progress', room.phaseEndsAt, GUESS_SECONDS);

    const submissionsThisRound = (room.submissions && room.submissions[round]) || {};
    const submittedCount = Object.keys(submissionsThisRound).length;
    const playerCount = Object.keys(room.players).length;

    if (submissionsThisRound[myUid]) {
      document.getElementById('btn-submit-color').disabled = true;
      document.getElementById('guess-hex').disabled = true;
      document.getElementById('guess-waiting-text').classList.remove('hidden');
    }

    if (isHost) {
      if (isNewKey) {
        scheduleHostTransition(room.phaseEndsAt, () => finishRound(room, round));
      }
      if (submittedCount >= playerCount) {
        clearHostTimer();
        finishRound(room, round);
      }
    }
  } else if (phase === 'result') {
    const results = (room.results && room.results[round]) || {};
    renderResult(room, round, target, results);
    showView('result');

    if (isHost && isNewKey) {
      scheduleHostTransition(room.phaseEndsAt, () => {
        if (round >= TOTAL_ROUNDS) finishGame(room);
        else startNextRound(round + 1);
      });
    }
  }
}

function renderResult(room, round, target, results) {
  document.getElementById('result-round').textContent = round;
  document.getElementById('result-target-box').style.background = target;

  const me = results[myUid];
  const opponentUid = Object.keys(room.players).find((uid) => uid !== myUid);
  const opponent = opponentUid ? results[opponentUid] : null;

  document.getElementById('result-p1-name').textContent = room.players[myUid]?.name || 'Bạn';
  document.getElementById('result-p1-box').style.background = me ? me.guess : '#888888';
  document.getElementById('result-p1-score').textContent = me ? `${me.accuracy.toFixed(2)}%` : '0.00%';

  document.getElementById('result-p2-name').textContent = opponentUid ? room.players[opponentUid]?.name : 'Đối thủ';
  document.getElementById('result-p2-box').style.background = opponent ? opponent.guess : '#888888';
  document.getElementById('result-p2-score').textContent = opponent ? `${opponent.accuracy.toFixed(2)}%` : '0.00%';
}

function renderGameOver(room) {
  lastRenderedKey = `gameover-${room.round}`;

  const scores = room.scores || {};
  const title = document.getElementById('summary-title');
  if (room.winner === 'draw') title.textContent = 'HÒA!';
  else if (room.winner === myUid) title.textContent = 'BẠN THẮNG!';
  else title.textContent = 'BẠN THUA!';

  const tbody = document.getElementById('summary-table-body');
  tbody.innerHTML = '';
  Object.entries(room.players).forEach(([uid, p]) => {
    const tr = document.createElement('tr');
    if (uid === room.winner) tr.classList.add('winner-row');
    tr.innerHTML = `<td>${p.name}</td><td>${(scores[uid] || 0).toFixed(2)}</td>`;
    tbody.appendChild(tr);
  });

  showView('summary');
}

// ---- Progress bar animation (client-visual only; authority is phaseEndsAt from DB) ----
function animateProgress(elementId, phaseEndsAt, duration) {
  const fill = document.getElementById(elementId);
  cancelAnimationFrame(progressRAF);

  function tick() {
    const remaining = phaseEndsAt - nowServer();
    const pct = Math.max(0, Math.min(100, (remaining / (duration * 1000)) * 100));
    fill.style.width = pct + '%';
    if (remaining > 0) progressRAF = requestAnimationFrame(tick);
  }
  tick();
}

// ---- Host-authority phase transitions ----
function clearHostTimer() {
  if (hostTimer) {
    clearTimeout(hostTimer);
    hostTimer = null;
  }
}

function scheduleHostTransition(phaseEndsAt, callback) {
  clearHostTimer();
  const delay = Math.max(0, phaseEndsAt - nowServer());
  hostTimer = setTimeout(callback, delay);
}

async function startGame(room) {
  const colors = Array.from({ length: TOTAL_ROUNDS }, () => randomHexColor());
  const resetScores = {};
  Object.keys(room.players).forEach((uid) => (resetScores[uid] = 0));

  await update(ref(db, `rooms/${roomId}`), {
    status: 'playing',
    colors,
    round: 1,
    phase: 'memorize',
    phaseEndsAt: nowServer() + MEMORIZE_SECONDS * 1000,
    submissions: {},
    results: {},
    scores: resetScores,
    winner: null,
  });
}

async function startGuessPhase() {
  await update(ref(db, `rooms/${roomId}`), {
    phase: 'guess',
    phaseEndsAt: nowServer() + GUESS_SECONDS * 1000,
  });
}

async function finishRound(room, round) {
  const target = room.colors[round - 1];
  const submissions = (room.submissions && room.submissions[round]) || {};
  const scores = { ...(room.scores || {}) };
  const results = {};

  Object.keys(room.players).forEach((uid) => {
    const guess = submissions[uid] || '#888888';
    const accuracy = calcAccuracy(target, guess);
    scores[uid] = Math.round(((scores[uid] || 0) + accuracy) * 100) / 100;
    results[uid] = { guess, accuracy };
  });

  await update(ref(db, `rooms/${roomId}`), {
    [`results/${round}`]: results,
    scores,
    phase: 'result',
    phaseEndsAt: nowServer() + RESULT_SECONDS * 1000,
  });
}

async function startNextRound(nextRound) {
  await update(ref(db, `rooms/${roomId}`), {
    round: nextRound,
    phase: 'memorize',
    phaseEndsAt: nowServer() + MEMORIZE_SECONDS * 1000,
  });
}

async function finishGame(room) {
  const scores = room.scores || {};
  const uids = Object.keys(room.players);
  let winner = 'draw';
  if (uids.length === 2) {
    const [a, b] = uids;
    if (scores[a] > scores[b]) winner = a;
    else if (scores[b] > scores[a]) winner = b;
  }

  await update(ref(db, `rooms/${roomId}`), { status: 'gameover', winner });
}

// ---- Color picker (iro.js) ----
function setupPicker() {
  const container = document.getElementById('picker-container');
  container.innerHTML = '';
  picker = new iro.ColorPicker(container, {
    width: 220,
    color: '#888888',
    layout: [
      { component: iro.ui.Box },
      { component: iro.ui.Slider, options: { sliderType: 'hue' } },
      { component: iro.ui.Slider, options: { sliderType: 'value' } },
    ],
  });
  picker.on('color:change', (color) => {
    currentColor = color.hexString;
    updatePreview(currentColor);
  });
}

function updatePreview(hex) {
  document.getElementById('guess-preview').style.background = hex;
  const hexInput = document.getElementById('guess-hex');
  if (document.activeElement !== hexInput) {
    hexInput.value = hex.toUpperCase();
  }
}

document.getElementById('guess-hex').addEventListener('input', (e) => {
  const raw = e.target.value.trim();
  const hex = raw.startsWith('#') ? raw : '#' + raw;
  if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    currentColor = hex;
    document.getElementById('guess-preview').style.background = hex;
    if (picker) picker.color.hexString = hex;
  }
});

document.getElementById('btn-submit-color').addEventListener('click', async () => {
  if (hasSubmitted || !currentRoom) return;
  hasSubmitted = true;
  document.getElementById('btn-submit-color').disabled = true;
  document.getElementById('guess-hex').disabled = true;
  document.getElementById('guess-waiting-text').classList.remove('hidden');
  await update(ref(db, `rooms/${roomId}`), {
    [`submissions/${currentRoom.round}/${myUid}`]: currentColor,
  });
});

// ---- Rematch ----
document.getElementById('btn-rematch').addEventListener('click', async () => {
  if (!currentRoom) return;
  lastRenderedKey = null;
  startGame(currentRoom);
});
