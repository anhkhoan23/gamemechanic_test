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
import { recognize, RUNE_TEMPLATES, RUNE_LABELS } from "./recognizer.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Namespace riêng trong cùng project Firebase, tách khỏi "rooms/" của Color Matcher.
const ROOT = "runeRooms";

// ---- Hằng số cân bằng (MVP - giá trị mặc định, cần tinh chỉnh qua playtest) ----
const MAX_HP = 100;
const MAX_MANA = 100;
const MANA_REGEN_PER_TURN = 40;
const DRAW_SECONDS = 20;
const RUSH_SECONDS = 5; // thời gian còn lại tối đa cho người vẽ sau khi đối thủ đã xác nhận
const RESULT_SECONDS = 8; // thời gian phát animation/kết quả
const BASE_ATTACK_DMG = 35;
const MAX_MITIGATION = 0.75; // phòng thủ hoàn hảo chặn tối đa 75% sát thương
const BASE_HEAL = 20;
const BASE_MANA_RESTORE = 25;
const MIN_MANA_COST = 8;
const MANA_COST_MULTIPLIER = 110; // cost = round(min(1, dienTichBoundingBox/dienTichCanvas) * multiplier)
const LOGICAL_CANVAS = 300; // hệ toạ độ chuẩn hoá, không phụ thuộc kích thước màn hình thật
const SUDDEN_DEATH_TURN = 10; // từ lượt này bắt đầu chip damage chống câu giờ
const CHIP_BASE = 6;

// ---- View management ----
const views = {
  menu: document.getElementById("view-menu"),
  waiting: document.getElementById("view-waiting"),
  draw: document.getElementById("view-draw"),
  result: document.getElementById("view-result"),
  summary: document.getElementById("view-summary"),
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[name].classList.add("active");
}

// ---- State ----
let myUid = null;
let myName = "";
let roomId = null;
let isHost = false;
let serverOffset = 0;
let currentRoom = null;
let lastRenderedKey = null;
let hostTimer = null;
let progressRAF = null;
let rushAppliedForKey = null; // tránh host rút ngắn giờ nhiều lần cho cùng 1 lượt

// Canvas drawing state
let canvas, ctx;
let isDrawing = false;
let currentStroke = [];
let hasSubmittedThisTurn = false;

function nowServer() {
  return Date.now() + serverOffset;
}

onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
  serverOffset = snap.val() || 0;
});

// ---- Auth ----
const menuError = document.getElementById("menu-error");

signInAnonymously(auth).catch((err) => {
  menuError.textContent = "Không thể kết nối Firebase Auth: " + err.message;
});

onAuthStateChanged(auth, (user) => {
  if (user) myUid = user.uid;
});

function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ---- Menu view ----
const inputName = document.getElementById("input-name");
const inputRoomCode = document.getElementById("input-room-code");

document.getElementById("btn-create-room").addEventListener("click", async () => {
  menuError.textContent = "";
  if (!myUid) {
    menuError.textContent = "Đang kết nối, vui lòng thử lại sau 1 giây.";
    return;
  }
  myName = inputName.value.trim() || "Player 1";
  roomId = randomRoomId();

  await set(ref(db, `${ROOT}/${roomId}`), {
    hostUid: myUid,
    players: { [myUid]: { name: myName } },
    status: "waiting",
    createdAt: serverTimestamp(),
  });

  onDisconnect(ref(db, `${ROOT}/${roomId}/players/${myUid}`)).remove();

  document.getElementById("waiting-room-code").textContent = roomId;
  showView("waiting");
  subscribeToRoom(roomId);
});

document.getElementById("btn-join-room").addEventListener("click", async () => {
  menuError.textContent = "";
  if (!myUid) {
    menuError.textContent = "Đang kết nối, vui lòng thử lại sau 1 giây.";
    return;
  }
  myName = inputName.value.trim() || "Player 2";
  const code = inputRoomCode.value.trim().toUpperCase();
  if (!code) {
    menuError.textContent = "Vui lòng nhập mã phòng.";
    return;
  }

  const roomSnap = await get(ref(db, `${ROOT}/${code}`));
  const room = roomSnap.val();
  if (!room) {
    menuError.textContent = "Phòng không tồn tại.";
    return;
  }
  if (room.players && Object.keys(room.players).length >= 2) {
    menuError.textContent = "Phòng đã đủ người.";
    return;
  }

  roomId = code;
  await update(ref(db, `${ROOT}/${roomId}`), {
    [`players/${myUid}`]: { name: myName },
  });

  onDisconnect(ref(db, `${ROOT}/${roomId}/players/${myUid}`)).remove();

  subscribeToRoom(roomId);
});

// ---- Room subscription ----
function subscribeToRoom(id) {
  onValue(ref(db, `${ROOT}/${id}`), (snap) => handleRoomUpdate(snap.val()));
}

function handleRoomUpdate(room) {
  currentRoom = room;

  if (!room) {
    alert("Phòng đã đóng hoặc đối thủ đã rời đi.");
    window.location.reload();
    return;
  }

  isHost = myUid === room.hostUid;
  const players = room.players || {};
  const playerCount = Object.keys(players).length;

  if (room.status === "waiting") {
    showView("waiting");
    document.getElementById("waiting-room-code").textContent = roomId;
    if (playerCount === 2 && isHost) startGame(room);
    return;
  }

  if (room.status !== "gameover" && playerCount < 2) {
    alert("Đối thủ đã rời phòng. Trò chơi kết thúc.");
    window.location.reload();
    return;
  }

  if (room.status === "playing") {
    renderPlayingState(room);
  } else if (room.status === "gameover") {
    renderGameOver(room);
  }
}

function opponentUidOf(room) {
  return Object.keys(room.players).find((uid) => uid !== myUid);
}

// ---- Playing state rendering ----
function renderPlayingState(room) {
  const turn = room.turn;
  const phase = room.phase;
  const key = `${turn}-${phase}`;
  const isNewKey = key !== lastRenderedKey;
  lastRenderedKey = key;

  renderHpManaBars(room);

  if (phase === "draw") {
    if (isNewKey) {
      hasSubmittedThisTurn = false;
      rushAppliedForKey = null;
      resetCanvas();
      document.getElementById("btn-submit-rune").disabled = true;
      document.getElementById("draw-waiting-text").classList.add("hidden");
      document.getElementById("mana-warning").textContent = "";
    }
    document.getElementById("draw-turn").textContent = turn;
    showView("draw");
    animateProgress("draw-progress", room.phaseEndsAt, DRAW_SECONDS);

    const strokesThisTurn = (room.strokes && room.strokes[turn]) || {};
    const submittedCount = Object.keys(strokesThisTurn).length;
    const playerCount = Object.keys(room.players).length;

    if (strokesThisTurn[myUid] && !hasSubmittedThisTurn) {
      // Đề phòng reload giữa chừng sau khi đã nộp.
      hasSubmittedThisTurn = true;
      lockDrawingUI();
    }

    if (isHost) {
      if (isNewKey) {
        scheduleHostTransition(room.phaseEndsAt, () => finishTurn(room, turn));
      }
      // Rush timer: đối thủ đã nộp trước, rút ngắn giờ còn lại của người kia xuống RUSH_SECONDS.
      if (submittedCount === 1 && rushAppliedForKey !== key) {
        const remaining = room.phaseEndsAt - nowServer();
        if (remaining > RUSH_SECONDS * 1000) {
          rushAppliedForKey = key;
          const newEndsAt = nowServer() + RUSH_SECONDS * 1000;
          update(ref(db, `${ROOT}/${roomId}`), { phaseEndsAt: newEndsAt });
          scheduleHostTransition(newEndsAt, () => finishTurn(room, turn));
        }
      }
      if (submittedCount >= playerCount) {
        clearHostTimer();
        finishTurn(room, turn);
      }
    }
  } else if (phase === "result") {
    const result = (room.results && room.results[turn]) || null;
    renderResult(room, turn, result);
    showView("result");
    animateProgress("result-progress", room.phaseEndsAt, RESULT_SECONDS);

    if (isHost && isNewKey) {
      scheduleHostTransition(room.phaseEndsAt, () => {
        const oUid = opponentUidOf(room);
        const hpDone = room.hp[myUid] <= 0 || room.hp[oUid] <= 0;
        if (hpDone) finishGame(room);
        else startNextTurn(room, turn + 1);
      });
    }
  }
}

function renderHpManaBars(room) {
  const oUid = opponentUidOf(room);
  const hp = room.hp || {};
  const mana = room.mana || {};

  document.getElementById("my-name").textContent = room.players[myUid]?.name || "Bạn";
  document.getElementById("opp-name").textContent = oUid ? room.players[oUid]?.name : "Đối thủ";

  setBar("my-hp-fill", hp[myUid], MAX_HP);
  setBar("my-mana-fill", mana[myUid], MAX_MANA);
  setBar("opp-hp-fill", oUid ? hp[oUid] : 0, MAX_HP);
  setBar("opp-mana-fill", oUid ? mana[oUid] : 0, MAX_MANA);

  document.getElementById("my-hp-text").textContent = `${Math.round(hp[myUid] ?? 0)}/${MAX_HP}`;
  document.getElementById("opp-hp-text").textContent = `${Math.round(oUid ? hp[oUid] : 0)}/${MAX_HP}`;
}

function setBar(id, value, max) {
  const pct = Math.max(0, Math.min(100, ((value ?? 0) / max) * 100));
  document.getElementById(id).style.width = pct + "%";
}

function renderResult(room, turn, result) {
  document.getElementById("result-turn").textContent = turn;
  const oUid = opponentUidOf(room);
  if (!result) return;

  const me = result[myUid];
  const opp = result[oUid];

  drawReplayStroke("result-my-canvas", me?.points);
  drawReplayStroke("result-opp-canvas", opp?.points);

  document.getElementById("result-my-name").textContent = room.players[myUid]?.name || "Bạn";
  document.getElementById("result-opp-name").textContent = oUid ? room.players[oUid]?.name : "Đối thủ";

  document.getElementById("result-my-label").textContent = me ? formatActionLabel(me) : "Không vẽ kịp";
  document.getElementById("result-opp-label").textContent = opp ? formatActionLabel(opp) : "Không vẽ kịp";

  document.getElementById("result-my-effect").textContent = me ? formatEffectLabel(me) : "";
  document.getElementById("result-opp-effect").textContent = opp ? formatEffectLabel(opp) : "";
}

function formatActionLabel(action) {
  if (!action.type) return "Không nhận diện được (miss)";
  const label = RUNE_LABELS[action.type] || action.type;
  return `${label} · ${Math.round(action.similarity * 100)}% chính xác`;
}

function formatEffectLabel(action) {
  const parts = [];
  if (action.damageDealt) parts.push(`Gây ${action.damageDealt} dmg`);
  if (action.damageTaken) parts.push(`Nhận ${action.damageTaken} dmg`);
  if (action.mitigatedPct) parts.push(`Đỡ ${Math.round(action.mitigatedPct * 100)}% dmg`);
  if (action.healed) parts.push(`Hồi ${action.healed} HP`);
  if (action.manaRestored) parts.push(`Hồi ${action.manaRestored} mana`);
  if (action.chipDamage) parts.push(`Ép thua: -${action.chipDamage} HP`);
  return parts.join(" · ") || "Không có hiệu ứng";
}

function renderGameOver(room) {
  lastRenderedKey = `gameover`;
  const title = document.getElementById("summary-title");
  if (room.winner === "draw") title.textContent = "HÒA!";
  else if (room.winner === myUid) title.textContent = "BẠN THẮNG!";
  else title.textContent = "BẠN THUA!";

  const oUid = opponentUidOf(room);
  const hp = room.hp || {};
  document.getElementById("summary-my-hp").textContent = `${Math.max(0, Math.round(hp[myUid] ?? 0))}/${MAX_HP}`;
  document.getElementById("summary-opp-hp").textContent = `${Math.max(0, Math.round(oUid ? hp[oUid] : 0))}/${MAX_HP}`;

  showView("summary");
}

// ---- Progress bar ----
function animateProgress(elementId, phaseEndsAt, duration) {
  const fill = document.getElementById(elementId);
  cancelAnimationFrame(progressRAF);
  function tick() {
    const remaining = phaseEndsAt - nowServer();
    const pct = Math.max(0, Math.min(100, (remaining / (duration * 1000)) * 100));
    fill.style.width = pct + "%";
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
  const resetHp = {};
  const resetMana = {};
  Object.keys(room.players).forEach((uid) => {
    resetHp[uid] = MAX_HP;
    resetMana[uid] = MAX_MANA;
  });

  await update(ref(db, `${ROOT}/${roomId}`), {
    status: "playing",
    turn: 1,
    phase: "draw",
    phaseEndsAt: nowServer() + DRAW_SECONDS * 1000,
    hp: resetHp,
    mana: resetMana,
    strokes: {},
    results: {},
    winner: null,
  });
}

async function startNextTurn(room, nextTurn) {
  const mana = { ...(room.mana || {}) };
  Object.keys(room.players).forEach((uid) => {
    mana[uid] = Math.min(MAX_MANA, (mana[uid] || 0) + MANA_REGEN_PER_TURN);
  });

  await update(ref(db, `${ROOT}/${roomId}`), {
    turn: nextTurn,
    phase: "draw",
    phaseEndsAt: nowServer() + DRAW_SECONDS * 1000,
    mana,
  });
}

// Chỉ host gọi hàm này (host-authority), đọc strokes đã nộp và tính toán kết quả lượt.
async function finishTurn(room, turn) {
  const uids = Object.keys(room.players);
  const [uidA, uidB] = uids;
  const strokes = (room.strokes && room.strokes[turn]) || {};

  function resolveAction(uid) {
    const s = strokes[uid];
    if (!s || !s.points || s.points.length < 2) {
      return { type: null, similarity: 0, cost: 0, points: [] };
    }
    const { type, similarity } = recognize(s.points, RUNE_TEMPLATES);
    return { type, similarity, cost: s.cost || 0, points: s.points };
  }

  const actionA = resolveAction(uidA);
  const actionB = resolveAction(uidB);

  function roleValues(action) {
    return {
      dmg: action.type === "attack" ? Math.round(BASE_ATTACK_DMG * action.similarity) : 0,
      mitigation: action.type === "defense" ? action.similarity * MAX_MITIGATION : 0,
      heal: action.type === "utility" ? Math.round(BASE_HEAL * action.similarity) : 0,
      manaRestore: action.type === "utility" ? Math.round(BASE_MANA_RESTORE * action.similarity) : 0,
    };
  }

  const rvA = roleValues(actionA);
  const rvB = roleValues(actionB);

  let dmgToA = Math.round(rvB.dmg * (1 - rvA.mitigation));
  let dmgToB = Math.round(rvA.dmg * (1 - rvB.mitigation));

  // Cơ chế ép thua: chip damage tăng dần sau SUDDEN_DEATH_TURN, vẫn bị giảm bởi phòng thủ.
  let chipA = 0;
  let chipB = 0;
  if (turn >= SUDDEN_DEATH_TURN) {
    const chip = CHIP_BASE * (turn - SUDDEN_DEATH_TURN + 1);
    chipA = Math.round(chip * (1 - rvA.mitigation));
    chipB = Math.round(chip * (1 - rvB.mitigation));
  }

  const hp = { ...(room.hp || {}) };
  const mana = { ...(room.mana || {}) };

  hp[uidA] = Math.max(0, Math.min(MAX_HP, (hp[uidA] || 0) - dmgToA - chipA + rvA.heal));
  hp[uidB] = Math.max(0, Math.min(MAX_HP, (hp[uidB] || 0) - dmgToB - chipB + rvB.heal));

  mana[uidA] = Math.max(0, Math.min(MAX_MANA, (mana[uidA] || 0) - actionA.cost + rvA.manaRestore));
  mana[uidB] = Math.max(0, Math.min(MAX_MANA, (mana[uidB] || 0) - actionB.cost + rvB.manaRestore));

  const results = {
    [uidA]: {
      type: actionA.type,
      similarity: actionA.similarity,
      points: actionA.points,
      damageDealt: dmgToB,
      damageTaken: dmgToA,
      mitigatedPct: rvA.mitigation,
      healed: rvA.heal,
      manaRestored: rvA.manaRestore,
      chipDamage: chipA,
    },
    [uidB]: {
      type: actionB.type,
      similarity: actionB.similarity,
      points: actionB.points,
      damageDealt: dmgToA,
      damageTaken: dmgToB,
      mitigatedPct: rvB.mitigation,
      healed: rvB.heal,
      manaRestored: rvB.manaRestore,
      chipDamage: chipB,
    },
  };

  await update(ref(db, `${ROOT}/${roomId}`), {
    [`results/${turn}`]: results,
    hp,
    mana,
    phase: "result",
    phaseEndsAt: nowServer() + RESULT_SECONDS * 1000,
  });
}

async function finishGame(room) {
  const oUid = opponentUidOf(room);
  const hp = room.hp || {};
  let winner = "draw";
  if (hp[myUid] > hp[oUid]) winner = myUid;
  else if (hp[oUid] > hp[myUid]) winner = oUid;

  await update(ref(db, `${ROOT}/${roomId}`), { status: "gameover", winner });
}

// ---- Canvas vẽ rune ----
function setupCanvasOnce() {
  canvas = document.getElementById("draw-canvas");
  canvas.width = LOGICAL_CANVAS;
  canvas.height = LOGICAL_CANVAS;
  ctx = canvas.getContext("2d");

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

function canvasPointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * LOGICAL_CANVAS;
  const y = ((e.clientY - rect.top) / rect.height) * LOGICAL_CANVAS;
  return { x, y };
}

function onPointerDown(e) {
  if (hasSubmittedThisTurn) return;
  isDrawing = true;
  currentStroke = [canvasPointFromEvent(e)];
  clearCanvas();
  document.getElementById("btn-submit-rune").disabled = true;
}

function onPointerMove(e) {
  if (!isDrawing || hasSubmittedThisTurn) return;
  const p = canvasPointFromEvent(e);
  const last = currentStroke[currentStroke.length - 1];
  if (dist2(last, p) < 9) return; // throttle: tối thiểu 3px logic mới ghi điểm mới
  currentStroke.push(p);
  drawSegment(last, p);
}

function onPointerUp() {
  if (!isDrawing) return;
  isDrawing = false;
  if (currentStroke.length >= 3) {
    document.getElementById("btn-submit-rune").disabled = false;
    updateManaEstimate();
  }
}

function dist2(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

function drawSegment(a, b) {
  ctx.strokeStyle = "#ff5733";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function clearCanvas() {
  ctx.clearRect(0, 0, LOGICAL_CANVAS, LOGICAL_CANVAS);
}

function resetCanvas() {
  if (!ctx) return;
  clearCanvas();
  currentStroke = [];
  isDrawing = false;
  document.getElementById("mana-cost-preview").textContent = "";
}

function strokeBoundingAreaRatio(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  points.forEach((p) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  });
  const area = Math.max(1, maxX - minX) * Math.max(1, maxY - minY);
  return Math.min(1, area / (LOGICAL_CANVAS * LOGICAL_CANVAS));
}

function estimateManaCost(points) {
  const ratio = strokeBoundingAreaRatio(points);
  return Math.max(MIN_MANA_COST, Math.round(ratio * MANA_COST_MULTIPLIER));
}

function updateManaEstimate() {
  const cost = estimateManaCost(currentStroke);
  const myMana = (currentRoom?.mana && currentRoom.mana[myUid]) ?? MAX_MANA;
  const preview = document.getElementById("mana-cost-preview");
  const warning = document.getElementById("mana-warning");
  preview.textContent = `Chi phí mana ước tính: ${cost}`;
  warning.textContent = cost > myMana ? "Không đủ mana! Vẽ hình nhỏ hơn hoặc chờ hồi mana." : "";
}

function lockDrawingUI() {
  document.getElementById("btn-submit-rune").disabled = true;
  document.getElementById("draw-waiting-text").classList.remove("hidden");
}

document.getElementById("btn-submit-rune").addEventListener("click", async () => {
  if (hasSubmittedThisTurn || !currentRoom || currentStroke.length < 3) return;
  const cost = estimateManaCost(currentStroke);
  const myMana = (currentRoom.mana && currentRoom.mana[myUid]) ?? MAX_MANA;
  if (cost > myMana) {
    document.getElementById("mana-warning").textContent = "Không đủ mana để nộp hình này.";
    return;
  }
  hasSubmittedThisTurn = true;
  lockDrawingUI();
  await update(ref(db, `${ROOT}/${roomId}`), {
    [`strokes/${currentRoom.turn}/${myUid}`]: { points: currentStroke, cost },
  });
});

// ---- Replay nét vẽ ở màn hình kết quả ----
function drawReplayStroke(canvasId, points) {
  const c = document.getElementById(canvasId);
  const rctx = c.getContext("2d");
  c.width = 150;
  c.height = 150;
  rctx.clearRect(0, 0, 150, 150);
  if (!points || points.length < 2) return;
  rctx.strokeStyle = "#4a90e2";
  rctx.lineWidth = 4;
  rctx.lineCap = "round";
  rctx.beginPath();
  points.forEach((p, i) => {
    const x = (p.x / LOGICAL_CANVAS) * 150;
    const y = (p.y / LOGICAL_CANVAS) * 150;
    if (i === 0) rctx.moveTo(x, y);
    else rctx.lineTo(x, y);
  });
  rctx.stroke();
}

// ---- Rematch ----
document.getElementById("btn-rematch").addEventListener("click", async () => {
  if (!currentRoom) return;
  lastRenderedKey = null;
  startGame(currentRoom);
});

setupCanvasOnce();
