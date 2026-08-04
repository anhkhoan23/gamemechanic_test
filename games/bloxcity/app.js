import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getDatabase, ref, set, get, push, update,
  onChildAdded, runTransaction
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";
import { firebaseConfig } from "../../firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

/* ============================================================
   CONSTANTS
   ============================================================ */
const ROOM_DURATION_MS = 10 * 60 * 1000;
const MAX_PLAYERS = 200;
const GRID_COLS = 15;
const PLOT_SPACING = 12;
const FLOOR_UNIT = 1.4;
const BASE_WIDTH = 6;
const MAX_FLOORS = 45;
const MISS_TOLERANCE = 0.15;

const PLAYER_COLORS = [
  "#f4b740","#5ea88a","#c1553b","#6f9ceb","#d98fd9",
  "#e0895a","#7fd1c7","#c9a0f5","#f28fa3","#8bd17f"
];

/* ============================================================
   STATE
   ============================================================ */
const state = {
  uid: getOrCreateUid(),
  name: "",
  color: "#f4b740",
  roomCode: null,
  plotIndex: 0,
  isHost: false,
  endsAt: 0,
  locked: false,
  mode: "build",
  floors: [],
  movingX: 0,
  movingDir: 1,
  currentWidth: BASE_WIDTH,
  timerHandle: null,
};

function getOrCreateUid(){
  let uid = sessionStorage.getItem("cb_uid");
  if(!uid){
    uid = (crypto.randomUUID ? crypto.randomUUID() : "u" + Math.random().toString(36).slice(2));
    sessionStorage.setItem("cb_uid", uid);
  }
  return uid;
}

function generateRoomCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for(let i=0;i<5;i++) code += chars[Math.floor(Math.random()*chars.length)];
  return code;
}

/* ============================================================
   LOBBY UI
   ============================================================ */
const $ = (sel) => document.querySelector(sel);
const nameInput = $("#nameInput");
const codeInput = $("#codeInput");
const lobbyError = $("#lobbyError");

$("#createRoomBtn").addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if(!name){ lobbyError.textContent = "Nhập tên trước đã nhé."; return; }
  setLobbyBusy(true);
  try{
    const code = await createRoom(name);
    await joinRoom(code, name, true);
  }catch(err){
    console.error(err);
    lobbyError.textContent = "Không tạo được phòng, thử lại nhé.";
  }
  setLobbyBusy(false);
});

$("#joinRoomBtn").addEventListener("click", async () => {
  const name = nameInput.value.trim();
  const code = codeInput.value.trim().toUpperCase();
  if(!name){ lobbyError.textContent = "Nhập tên trước đã nhé."; return; }
  if(!code){ lobbyError.textContent = "Nhập mã phòng."; return; }
  setLobbyBusy(true);
  try{
    await joinRoom(code, name, false);
  }catch(err){
    console.error(err);
    lobbyError.textContent = err.message || "Không vào được phòng.";
  }
  setLobbyBusy(false);
});

function setLobbyBusy(busy){
  $("#createRoomBtn").disabled = busy;
  $("#joinRoomBtn").disabled = busy;
  lobbyError.textContent = "";
}

/* ============================================================
   ROOM CREATE / JOIN
   ============================================================ */
async function createRoom(hostName){
  let code;
  for(let i=0;i<5;i++){
    const candidate = generateRoomCode();
    const snap = await get(ref(db, `cityRooms/${candidate}/meta`));
    if(!snap.exists()){ code = candidate; break; }
  }
  if(!code) throw new Error("retry");

  const now = Date.now();
  await set(ref(db, `cityRooms/${code}/meta`), {
    hostId: state.uid,
    createdAt: now,
    endsAt: now + ROOM_DURATION_MS,
    playerCount: 0
  });
  return code;
}

async function joinRoom(code, name, isHost){
  const metaSnap = await get(ref(db, `cityRooms/${code}/meta`));
  if(!metaSnap.exists()) throw new Error("Không tìm thấy phòng này.");
  const meta = metaSnap.val();
  if(Date.now() > meta.endsAt) throw new Error("Phòng đã kết thúc.");

  const counterRef = ref(db, `cityRooms/${code}/meta/playerCount`);
  const result = await runTransaction(counterRef, (current) => {
    current = current || 0;
    if(current >= MAX_PLAYERS) return;
    return current + 1;
  });
  if(!result.committed) throw new Error("Phòng đã đầy (200 người).");

  const plotIndex = result.snapshot.val() - 1;
  const color = PLAYER_COLORS[plotIndex % PLAYER_COLORS.length];

  state.roomCode = code;
  state.plotIndex = plotIndex;
  state.name = name;
  state.color = color;
  state.isHost = isHost;
  state.endsAt = meta.endsAt;

  await set(ref(db, `cityRooms/${code}/players/${state.uid}`), {
    name, color, plotIndex, joinedAt: Date.now()
  });

  enterGame(code);
}

/* ============================================================
   ENTER GAME
   ============================================================ */
function enterGame(code){
  $("#lobby").style.display = "none";
  $("#game").style.display = "block";
  $("#roomCodeDisplay").textContent = code;

  const foundation = { w: BASE_WIDTH, x: 0 };
  state.floors = [foundation];
  state.currentWidth = BASE_WIDTH;
  pushBlockToFirebase(foundation);

  startTimer();
  startCityListeners(code);
  initBuildCanvas();
  initObserveScene();
  requestAnimationFrame(buildLoop);

  $("#toggleModeBtn").addEventListener("click", toggleMode);
  window.addEventListener("keydown", (e) => { if(e.code === "Space") { e.preventDefault(); onDropInput(); } });
}

/* ============================================================
   TIMER
   ============================================================ */
function startTimer(){
  const timerEl = $("#timer");
  state.timerHandle = setInterval(() => {
    const remain = state.endsAt - Date.now();
    if(remain <= 0){
      clearInterval(state.timerHandle);
      timerEl.textContent = "00:00";
      lockBuilding();
      return;
    }
    const m = Math.floor(remain / 60000);
    const s = Math.floor((remain % 60000) / 1000);
    timerEl.textContent = `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    timerEl.classList.toggle("low", remain < 60000);
  }, 250);
}

function lockBuilding(){
  state.locked = true;
  $("#endedBanner").style.display = "block";
  $("#dropHint").style.display = "none";
}

/* ============================================================
   BUILD MODE (2D) — Tower Bloxx style
   ============================================================ */
let ctx, canvasW, canvasH;
const SCALE_PX = 26;
const FLOOR_H_PX = 28;
const AMPLITUDE = 5;
let baseSpeed = 2.6;

function initBuildCanvas(){
  const canvas = $("#buildCanvas");
  ctx = canvas.getContext("2d");
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  canvas.addEventListener("pointerdown", onDropInput);
  resetMovingBlock();
}

function resizeCanvas(){
  const canvas = $("#buildCanvas");
  canvasW = canvas.width = canvas.clientWidth * devicePixelRatio;
  canvasH = canvas.height = canvas.clientHeight * devicePixelRatio;
}

function resetMovingBlock(){
  state.movingX = 0;
  state.movingDir = 1;
}

let lastT = performance.now();
function buildLoop(t){
  const dt = Math.min((t - lastT) / 1000, 0.05);
  lastT = t;

  if(state.mode === "build"){
    if(!state.locked){
      const speed = baseSpeed + Math.min(state.floors.length * 0.035, 2.2);
      const half = state.currentWidth / 2;
      state.movingX += state.movingDir * speed * dt;
      if(state.movingX + half > AMPLITUDE){ state.movingX = AMPLITUDE - half; state.movingDir = -1; }
      if(state.movingX - half < -AMPLITUDE){ state.movingX = -AMPLITUDE + half; state.movingDir = 1; }
    }
    drawBuild();
  }
  requestAnimationFrame(buildLoop);
}

function drawBuild(){
  const cx = canvasW / 2;
  const scale = SCALE_PX * devicePixelRatio;
  const floorH = FLOOR_H_PX * devicePixelRatio;
  const floors = state.floors;
  const scrollY = Math.max(0, floors.length - Math.floor(canvasH / floorH) + 4) * floorH;

  ctx.fillStyle = "#0f1b2d";
  ctx.fillRect(0, 0, canvasW, canvasH);

  ctx.strokeStyle = "rgba(36,64,95,0.35)";
  ctx.lineWidth = 1;
  for(let y = canvasH + scrollY % floorH; y > -floorH; y -= floorH){
    ctx.beginPath(); ctx.moveTo(0, y - scrollY); ctx.lineTo(canvasW, y - scrollY); ctx.stroke();
  }

  floors.forEach((f, i) => {
    const y = canvasH - (i + 1) * floorH + scrollY;
    const x = cx + f.x * scale - (f.w * scale) / 2;
    ctx.fillStyle = i === 0 ? "#3a4d63" : state.color;
    roundRect(ctx, x, y, f.w * scale, floorH - 2, 4);
    ctx.fill();
  });

  if(!state.locked && floors.length < MAX_FLOORS){
    const y = canvasH - (floors.length + 1) * floorH + scrollY;
    const x = cx + state.movingX * scale - (state.currentWidth * scale) / 2;
    ctx.fillStyle = state.color;
    ctx.globalAlpha = 0.9;
    roundRect(ctx, x, y, state.currentWidth * scale, floorH - 2, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  $("#floorNum").textContent = Math.max(0, floors.length - 1);
}

function roundRect(c, x, y, w, h, r){
  c.beginPath();
  c.moveTo(x+r, y);
  c.arcTo(x+w, y, x+w, y+h, r);
  c.arcTo(x+w, y+h, x, y+h, r);
  c.arcTo(x, y+h, x, y, r);
  c.arcTo(x, y, x+w, y, r);
  c.closePath();
}

function onDropInput(){
  if(state.mode !== "build" || state.locked) return;
  if(state.floors.length >= MAX_FLOORS) return;
  dropBlock();
}

function dropBlock(){
  const prev = state.floors[state.floors.length - 1];
  const curX = state.movingX, curW = state.currentWidth;
  const prevLeft = prev.x - prev.w/2, prevRight = prev.x + prev.w/2;
  const curLeft = curX - curW/2, curRight = curX + curW/2;
  const overlapLeft = Math.max(prevLeft, curLeft);
  const overlapRight = Math.min(prevRight, curRight);
  const overlapW = overlapRight - overlapLeft;

  if(overlapW <= MISS_TOLERANCE){
    showToast("Trượt rồi! Thử lại tầng này");
    return;
  }

  const newWidth = overlapW;
  const newX = (overlapLeft + overlapRight) / 2;
  const floorData = { w: newWidth, x: newX };
  state.floors.push(floorData);
  state.currentWidth = newWidth;

  pushBlockToFirebase(floorData);

  if(state.floors.length >= MAX_FLOORS){
    showToast("Chúc mừng! Nhà bạn đã đạt chiều cao tối đa");
  }
}

function showToast(msg){
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 1400);
}

/* ============================================================
   FIREBASE SYNC
   ============================================================ */
function pushBlockToFirebase(floorData){
  if(!state.roomCode) return;
  const blocksRef = ref(db, `cityRooms/${state.roomCode}/players/${state.uid}/blocks`);
  push(blocksRef, { ...floorData, color: state.color, t: Date.now() });
}

/* ============================================================
   CITY LISTENERS
   ============================================================ */
const cityPlayers = new Map();

function startCityListeners(code){
  const playersRef = ref(db, `cityRooms/${code}/players`);
  onChildAdded(playersRef, (snap) => {
    const uid = snap.key;
    const data = snap.val();
    registerCityPlayer(uid, data);

    const blocksRef = ref(db, `cityRooms/${code}/players/${uid}/blocks`);
    onChildAdded(blocksRef, (bsnap) => {
      addBlockToCity(uid, bsnap.val());
    });
  });
}

/* ============================================================
   OBSERVE MODE (3D) — three.js
   ============================================================ */
let renderer, scene, camera, controls;

function initObserveScene(){
  const container = $("#observeContainer");
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1b2d);
  scene.fog = new THREE.Fog(0x0f1b2d, 80, 260);

  const citySpan = GRID_COLS * PLOT_SPACING;
  camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(citySpan * 0.15, citySpan * 0.55, citySpan * 0.55);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(citySpan / 2, 0, citySpan / 2);
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 10;
  controls.maxDistance = citySpan * 1.3;
  controls.update();

  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x1a2436, 0.9);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(60, 120, 40);
  scene.add(dir);

  const groundGrid = new THREE.GridHelper(citySpan + PLOT_SPACING, GRID_COLS + 1, 0x24405f, 0x1a2c42);
  groundGrid.position.set(citySpan/2 - PLOT_SPACING/2, 0, citySpan/2 - PLOT_SPACING/2);
  scene.add(groundGrid);

  const groundMat = new THREE.MeshStandardMaterial({ color: 0x122032, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(citySpan*2, citySpan*2), groundMat);
  ground.rotation.x = -Math.PI/2;
  ground.position.y = -0.02;
  scene.add(ground);

  window.addEventListener("resize", () => {
    if(!container.clientWidth) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  requestAnimationFrame(observeLoop);
}

function observeLoop(){
  requestAnimationFrame(observeLoop);
  if(state.mode !== "observe") return;
  controls.update();
  renderer.render(scene, camera);
}

function plotPosition(plotIndex){
  const col = plotIndex % GRID_COLS;
  const row = Math.floor(plotIndex / GRID_COLS);
  return { x: col * PLOT_SPACING, z: row * PLOT_SPACING };
}

function registerCityPlayer(uid, data){
  if(cityPlayers.has(uid)) return;
  const { x, z } = plotPosition(data.plotIndex);
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  scene.add(group);

  const nameSprite = makeNameSprite(data.name);
  nameSprite.position.set(0, 1.2, 0);
  group.add(nameSprite);

  cityPlayers.set(uid, {
    group, nameSprite, floorCount: 0, x, z,
    color: data.color, name: data.name
  });
}

function addBlockToCity(uid, block){
  const entry = cityPlayers.get(uid);
  if(!entry) return;
  const geo = new THREE.BoxGeometry(block.w, FLOOR_UNIT * 0.95, block.w);
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(block.color || entry.color), roughness: 0.6 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(block.x, entry.floorCount * FLOOR_UNIT + FLOOR_UNIT/2, 0);
  entry.group.add(mesh);
  entry.floorCount += 1;
  entry.nameSprite.position.y = entry.floorCount * FLOOR_UNIT + 1.0;
}

function makeNameSprite(name){
  const canvas = document.createElement("canvas");
  const size = 256;
  canvas.width = size; canvas.height = 64;
  const c = canvas.getContext("2d");
  c.font = "600 30px Inter, sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  const textWidth = c.measureText(name).width;
  const padX = 18;
  c.fillStyle = "rgba(15,27,45,0.85)";
  roundRect(c, size/2 - textWidth/2 - padX, 12, textWidth + padX*2, 40, 10);
  c.fill();
  c.fillStyle = "#eae6da";
  c.fillText(name, size/2, 32);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4.2, 1.05, 1);
  sprite.renderOrder = 999;
  return sprite;
}

/* ============================================================
   TOGGLE BUILD / OBSERVE
   ============================================================ */
function toggleMode(){
  if(state.mode === "build"){
    state.mode = "observe";
    $("#buildScreen").style.display = "none";
    $("#observeScreen").style.display = "block";
    $("#toggleModeBtn").textContent = "Về xây nhà ⤵";
  } else {
    state.mode = "build";
    $("#observeScreen").style.display = "none";
    $("#buildScreen").style.display = "block";
    $("#toggleModeBtn").textContent = "Xem toàn cảnh ⤴";
    resizeCanvas();
  }
}
