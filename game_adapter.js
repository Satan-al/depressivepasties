import {
  ref, onValue, onChildAdded, onChildChanged, onChildRemoved,
  set, update, remove, push, get, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

const SESSION_KEY = "DepressivePasties";
const GAME_VERSION = "game_v1";
const ADAPTER_VERSION = "native-ws-v2.17-traitor-vote-intro-finale";
const BASE_PATH = `sessions/${SESSION_KEY}/${GAME_VERSION}`;
const POINTS_PATH = `sessions/${SESSION_KEY}/points`;
const GAME_POINTS_PATH = `${BASE_PATH}/game_points`;
const ENTRANCE_PATH = `${BASE_PATH}/entrance`;
const BRIDGE_LIVE_PATH = `${BASE_PATH}/bridge_live`;
const TRAITOR_VOTE_PATH = `${BASE_PATH}/traitor_vote`;
const params = new URLSearchParams(location.search);
const IS_GAME_HOST = params.get("gamehost") === "1";
const IS_NATIVE_BRIDGE = params.get("nativebridge") === "1";
const IS_GAME_CONTROLLER = IS_GAME_HOST || IS_NATIVE_BRIDGE;
const GAME_BUILD_URL = params.get("gameBuild") || "./game-build/index.html?embedded=1&bridge=5";
const NATIVE_WS_URL = params.get("nativeWs") || "ws://127.0.0.1:9080";
const GAME_DISCONNECT_GRACE_MS = 650;
const GAME_HEARTBEAT_INTERVAL_MS = 1000;
const GAME_HEARTBEAT_STALE_MS = 4500;
const initAt = Date.now();

// Native bridge and the ordinary site are usually two tabs of the same origin.
// Firebase remains the source of truth for remote guests, but a local
// BroadcastChannel makes the map react immediately and avoids losing the live
// state when a partial/stale Firebase snapshot arrives between heartbeats.
const LOCAL_STATE_CHANNEL_NAME = "dp-horror-local-state-v1";
const LOCAL_STATE_STALE_MS = 5500;
let localStateChannel = null;
let lastLocalControllerPulseAt = 0;
let applyPublicStateSnapshot = null;
let pendingLocalPublicState = null;

function ensureLocalStateChannel() {
  if (localStateChannel || typeof BroadcastChannel !== "function") return localStateChannel;
  try {
    localStateChannel = new BroadcastChannel(LOCAL_STATE_CHANNEL_NAME);
    localStateChannel.addEventListener("message", event => {
      const message = event?.data;
      if (!message || message.channel !== "dp-horror-local-state") return;
      if (IS_GAME_CONTROLLER) return;

      if (message.type === "public_state" || message.type === "heartbeat") {
        lastLocalControllerPulseAt = Date.now();
        const incoming = {
          ...(gamePublic || {}),
          ...(message.payload || {}),
          bridgeConnected: true,
          bridgeHeartbeatAt: Number(message.sentAt || Date.now())
        };
        if (applyPublicStateSnapshot) applyPublicStateSnapshot(incoming);
        else pendingLocalPublicState = incoming;
        return;
      }

      if (message.type === "exit_complete") {
        const uid = String(message.payload?.uid || "");
        if (!uid) return;
        completedExitTombstones.set(uid, Date.now());
        const existing = entranceRequests.get(uid) || {};
        entranceRequests.set(uid, {
          ...existing,
          status: "outside",
          controllerState: "detached",
          exitRequested: false,
          bodyPresent: false,
          targetId: null
        });
        bridgePoints.delete(uid);
        runtimeStates.delete(uid);
        helpTargets.delete(uid);
        renderAdmissionUi();
        renderMap();
        scheduleSnapshotToGame();
        return;
      }

      if (message.type === "end_game") {
        lastLocalControllerPulseAt = 0;
        const incoming = {
          ...(gamePublic || {}),
          active: false,
          bridgeConnected: false,
          bridgeHeartbeatAt: Number(message.sentAt || Date.now())
        };
        if (applyPublicStateSnapshot) applyPublicStateSnapshot(incoming);
        else pendingLocalPublicState = incoming;
      }
    });
  } catch (error) {
    console.warn("[DP game] BroadcastChannel unavailable", error);
    localStateChannel = null;
  }
  return localStateChannel;
}

function broadcastLocalState(type, payload = {}) {
  if (!IS_GAME_CONTROLLER) return;
  const channel = ensureLocalStateChannel();
  if (!channel) return;
  try {
    channel.postMessage({
      channel: "dp-horror-local-state",
      type,
      sentAt: Date.now(),
      payload
    });
  } catch (error) {
    console.warn("[DP game] local state broadcast failed", error);
  }
}

function localHeartbeatPayload(now = Date.now()) {
  return {
    active: Boolean(gamePublic?.active),
    inputMode: String(gamePublic?.inputMode || "map"),
    sceneId: String(gamePublic?.sceneId || ""),
    sceneLabel: String(gamePublic?.sceneLabel || ""),
    phase: String(gamePublic?.phase || ""),
    requireAdmission: Boolean(gamePublic?.requireAdmission),
    entrySpawn: gamePublic?.entrySpawn || null,
    mapRect: gamePublic?.mapRect || null,
    map: gamePublic?.map || null,
    runId: String(gamePublic?.runId || activeRunId || ""),
    runStartedAt: Number(gamePublic?.runStartedAt || activeRunStartedAt || 0),
    stateRevision: Number(gamePublic?.stateRevision || activeStateRevision || 0),
    bridgeConnected: true,
    bridgeHeartbeatAt: now
  };
}


// Godot Web \u043D\u0435\u043B\u044C\u0437\u044F \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0442\u044C, \u043F\u043E\u043A\u0430 iframe \u0438\u043C\u0435\u0435\u0442 \u043D\u0443\u043B\u0435\u0432\u043E\u0439 \u0440\u0430\u0437\u043C\u0435\u0440: WebGL \u0441\u043E\u0437\u0434\u0430\u0451\u0442
// framebuffer 0x0 \u0438 \u0437\u0430\u0441\u044B\u043F\u0430\u0435\u0442 \u043A\u043E\u043D\u0441\u043E\u043B\u044C GL_INVALID_FRAMEBUFFER_OPERATION.
// \u041E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 index.html \u043F\u044B\u0442\u0430\u0435\u0442\u0441\u044F \u043F\u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C src \u0441\u0440\u0430\u0437\u0443 \u043F\u043E\u0441\u043B\u0435 \u043B\u043E\u0433\u0438\u043D\u0430, \u043F\u043E\u044D\u0442\u043E\u043C\u0443
// \u043F\u0435\u0440\u0435\u0445\u0432\u0430\u0442\u044B\u0432\u0430\u0435\u043C \u044D\u0442\u043E \u0438 \u043E\u0442\u043F\u0443\u0441\u043A\u0430\u0435\u043C iframe \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u043E\u0441\u043B\u0435 \u0433\u043E\u0442\u043E\u0432\u043D\u043E\u0441\u0442\u0438 layout \u0438 bridge.
let hostIframeGate = null;

function armHostIframeGate() {
  if (!IS_GAME_HOST) return;
  const arm = () => {
    const player = document.getElementById("player");
    if (!player || player.dataset.dpIframeGate === "armed") return;
    player.dataset.dpIframeGate = "armed";
    player.dataset.dpIframeReleased = "0";
    player.style.visibility = "hidden";

    let internalWrite = false;
    const blank = () => {
      if (player.dataset.dpIframeReleased === "1") return;
      const raw = player.getAttribute("src") || "";
      if (raw === "about:blank") return;
      internalWrite = true;
      player.setAttribute("src", "about:blank");
      internalWrite = false;
    };

    const observer = new MutationObserver(() => {
      if (!internalWrite && player.dataset.dpIframeReleased !== "1") blank();
    });
    observer.observe(player, { attributes: true, attributeFilter: ["src"] });
    blank();
    hostIframeGate = { player, observer };
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", arm, { once: true });
  } else {
    arm();
  }
}

armHostIframeGate();

function armNativeBridgePage() {
  if (!IS_NATIVE_BRIDGE) return;
  const arm = () => {
    document.body?.classList.add("native-bridge-mode");
    const player = document.getElementById("player");
    if (!player || player.dataset.dpNativeGate === "armed") return;
    player.dataset.dpNativeGate = "armed";
    player.style.display = "none";

    let internalWrite = false;
    const blank = () => {
      const raw = player.getAttribute("src") || "";
      if (raw === "about:blank") return;
      internalWrite = true;
      player.setAttribute("src", "about:blank");
      internalWrite = false;
    };

    const observer = new MutationObserver(() => {
      if (!internalWrite) blank();
    });
    observer.observe(player, { attributes: true, attributeFilter: ["src"] });
    blank();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", arm, { once: true });
  } else {
    arm();
  }
}

armNativeBridgePage();

let db = null;
let auth = null;
let state = null;
let gamePublic = { active: false, inputMode: "map", mapRect: null, map: null };
let traitorVoteState = {};
let traitorVoteListenerBound = false;
let dismissedTraitorRevealAt = 0;
const gameMessages = new Map();
const gameEntities = new Map();
const entranceRequests = new Map();
const completedExitTombstones = new Map();
const helpTargets = new Map();
const admissionSpawnWritten = new Set();
let privateBoundUid = "";
let lastRealChatKey = "";
let backendReady = false;
const pendingGameEvents = [];
let snapshotPumpStarted = false;
let lastBridgeHeartbeatWriteAt = 0;

// \u0421\u0432\u043E\u044F \u0437\u0435\u0440\u043A\u0430\u043B\u044C\u043D\u0430\u044F \u043A\u0430\u0440\u0442\u0430 \u0442\u043E\u0447\u0435\u043A \u0434\u043B\u044F \u0438\u0433\u0440\u043E\u0432\u043E\u0433\u043E \u043C\u043E\u0441\u0442\u0430.
// \u041D\u0435 \u0436\u0434\u0451\u043C, \u043F\u043E\u043A\u0430 \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 index.html \u043E\u0431\u043D\u043E\u0432\u0438\u0442 state.points: Firebase-\u0441\u043E\u0431\u044B\u0442\u0438\u0435
// \u0441\u0440\u0430\u0437\u0443 \u0442\u043E\u043B\u043A\u0430\u0435\u0442 \u043D\u043E\u0432\u044B\u0439 snapshot \u0432 Godot. \u042D\u0442\u043E \u043E\u0441\u043E\u0431\u0435\u043D\u043D\u043E \u0432\u0430\u0436\u043D\u043E, \u043A\u043E\u0433\u0434\u0430 \u0432\u043A\u043B\u0430\u0434\u043A\u0430
// nativebridge \u043D\u0430\u0445\u043E\u0434\u0438\u0442\u0441\u044F \u0432 \u0444\u043E\u043D\u0435 \u0438 \u0431\u0440\u0430\u0443\u0437\u0435\u0440 \u0440\u0435\u0436\u0435\u0442 setInterval.
const bridgePoints = new Map();
let bridgePointsBound = false;
let snapshotSendQueued = false;
const mapCaptureAssemblies = new Map();
let gameEventChain = Promise.resolve();
let criticalGameEventChain = Promise.resolve();
const runtimeStates = new Map();
const entranceWriteChains = new Map();
let publicWriteChain = Promise.resolve();
let helpTargetsWriteChain = Promise.resolve();
let activeRunId = "";
let activeRunStartedAt = 0;
let activeStateRevision = 0;
let publicRecoveryStarted = false;
let helpTargetsListenerBound = false;
let hostCorpseListenerBound = false;
let hostCorpseState = null;
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [uid, stamp] of completedExitTombstones) {
    if (Number(stamp || 0) < cutoff) completedExitTombstones.delete(uid);
  }
}, 15000);

const CRITICAL_GAME_EVENT_TYPES = new Set([
  "reset_entrance",
  "help_target_state",
  "host_corpse_state",
  "participant_runtime_state",
  "guest_arrived",
  "guest_waiting_door_open",
  "begin_admission",
  "complete_admission",
  "admit_player",
  "complete_exit",
  "exit_complete",
  "traitor_vote_start",
  "traitor_vote_host_choice_ready",
  "traitor_vote_reveal",
  "traitor_vote_intro_finished",
  "traitor_vote_reset",
  "end_game"
]);

function isCriticalGameEvent(event) {
  const type = String(event?.type || "");
  return type === "publish_state" || CRITICAL_GAME_EVENT_TYPES.has(type);
}

function enqueueGameEvent(event) {
  if (isCriticalGameEvent(event)) {
    criticalGameEventChain = criticalGameEventChain
      .then(() => receiveFromGame(event))
      .catch(error => console.error("[DP game] critical event failed", event?.type, error));
    return criticalGameEventChain;
  }

  gameEventChain = gameEventChain
    .then(() => receiveFromGame(event))
    .catch(error => console.error("[DP game] event processing failed", event?.type, error));
  return gameEventChain;
}

function currentRunId() {
  return String(activeRunId || gamePublic?.runId || "");
}

function currentRunStartedAt() {
  return Number(activeRunStartedAt || gamePublic?.runStartedAt || 0);
}

function rowMatchesCurrentRun(row) {
  const runId = currentRunId();
  if (!runId) return true;
  return String(row?.runId || "") === runId;
}

function activateRun(runId, startedAt = 0) {
  const nextRunId = String(runId || "");
  const nextStartedAt = Number(startedAt || 0);
  if (!nextRunId) return true;
  if (activeRunId === nextRunId) {
    activeRunStartedAt = Math.max(activeRunStartedAt, nextStartedAt);
    return true;
  }
  if (
    activeRunId && nextStartedAt && activeRunStartedAt &&
    nextStartedAt < activeRunStartedAt
  ) return false;

  const shouldClearLocal = Boolean(activeRunId) || IS_GAME_CONTROLLER;
  activeRunId = nextRunId;
  activeRunStartedAt = nextStartedAt;
  activeStateRevision = 0;
  if (shouldClearLocal) {
    entranceRequests.clear();
    bridgePoints.clear();
    runtimeStates.clear();
    helpTargets.clear();
    admissionSpawnWritten.clear();
  } else {
    for (const [uid, row] of entranceRequests) {
      if (String(row?.runId || "") !== nextRunId) entranceRequests.delete(uid);
    }
    for (const [uid, row] of bridgePoints) {
      if (String(row?.runId || "") !== nextRunId) bridgePoints.delete(uid);
    }
  }
  gamePublic = {
    ...(gamePublic || {}),
    runId: activeRunId,
    runStartedAt: activeRunStartedAt,
    helpTargets: []
  };
  renderAdmissionUi();
  renderMap();
  scheduleSnapshotToGame();
  return true;
}

function eventRunMeta(event) {
  const payload = event?.payload || {};
  return {
    runId: String(payload.runId || ""),
    runStartedAt: Number(payload.runStartedAt || 0)
  };
}

function eventBelongsToActiveRun(event) {
  const meta = eventRunMeta(event);
  if (!meta.runId || !activeRunId) return true;
  return meta.runId === activeRunId;
}

function queuePublicPatch(patch) {
  const payload = { ...(patch || {}) };
  publicWriteChain = publicWriteChain
    .catch(() => {})
    .then(() => update(ref(db, `${BASE_PATH}/public`), {
      ...payload,
      updatedAt: serverTimestamp(),
      updatedBy: window.__ccCanonicalUid?.() || auth?.currentUser?.uid || "host"
    }))
    .catch(error => console.warn("[DP game] public state write failed", error));
  return publicWriteChain;
}

function queueEntranceWrite(uid, value) {
  const previous = entranceWriteChains.get(uid) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await update(ref(db, `${ENTRANCE_PATH}/${uid}`), value);
          return;
        } catch (error) {
          lastError = error;
          await delay(180 * (attempt + 1));
        }
      }
      console.error(`[DP game] entrance write failed for ${uid}`, lastError);
    });
  entranceWriteChains.set(uid, next);
  void next.finally(() => {
    if (entranceWriteChains.get(uid) === next) entranceWriteChains.delete(uid);
  });
  return next;
}

const CHARACTER_NAMES = {
  leha: "\u041B\u0451\u0445\u0430",
  timur: "\u0422\u0438\u043C\u0443\u0440",
  den: "\u0414\u0435\u043D",
  sasha: "\u0421\u0430\u043D\u044F",
  nastya: "\u041D\u0430\u0441\u0442\u044F",
  alyona: "\u0410\u043B\u0451\u043D\u0430",
  guest: "\u0413\u043E\u0441\u0442\u044C"
};

// \u0422\u043E\u0447\u043D\u043E\u0435 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0435 \u043D\u0438\u043A\u0430 \u043D\u0430 \u0441\u0430\u0439\u0442\u0435 \u0438 \u0441\u044E\u0436\u0435\u0442\u043D\u043E\u0439 \u0440\u043E\u043B\u0438.
// \u0412 \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0435, \u0447\u0430\u0442\u0435 \u0438 \u043F\u043E\u0434\u0434\u0435\u043B\u043A\u0430\u0445 \u0432\u0441\u0451 \u0440\u0430\u0432\u043D\u043E \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0430\u043A\u0442\u0443\u0430\u043B\u044C\u043D\u044B\u0439 \u043D\u0438\u043A \u0441 \u0441\u0430\u0439\u0442\u0430.
const ROLE_BY_SITE_NICK = new Map([
  ["tdurieux", "timur"],
  ["d", "den"],
  ["alex", "sasha"],
  ["gwynlayer", "nastya"],
  ["salyose", "alyona"],
  ["\u043B\u0435\u0445\u0430", "leha"],
  ["\u043B\u0451\u0445\u0430", "leha"],
  ["host", "leha"]
]);

const ROLE_ALIASES = new Map([
  ["\u0442\u0438\u043C\u0443\u0440", "timur"],
  ["\u0434\u0435\u043D", "den"],
  ["\u0434\u0435\u043D\u0438\u0441", "den"],
  ["\u0430\u043B\u0435\u043A\u0441\u0430\u043D\u0434\u0440\u0430", "sasha"],
  ["\u0441\u0430\u0448\u0430", "sasha"],
  ["\u0441\u0430\u043D\u044F", "sasha"],
  ["\u043D\u0430\u0441\u0442\u044F", "nastya"],
  ["\u0430\u043D\u0430\u0441\u0442\u0430\u0441\u0438\u044F", "nastya"],
  ["\u0430\u043B\u0435\u043D\u0430", "alyona"],
  ["\u0430\u043B\u0451\u043D\u0430", "alyona"]
]);

const DEFAULT_NICK_BY_ROLE = {
  timur: "Tdurieux",
  den: "D",
  sasha: "Alex",
  nastya: "gwynlayer",
  alyona: "Salyose",
  leha: "\u041B\u0451\u0445\u0430"
};

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\[(?:tg|\u0442\u0433)\]/giu, "")
    .replaceAll("\u0451", "\u0435")
    .replace(/[\u{1F480}\u2620\u26B0\uFE0E\uFE0F\u200D]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function detectRole(name, uid = "") {
  if (String(uid) === "host_leha") return "leha";
  const clean = normalizeName(name);
  if (ROLE_BY_SITE_NICK.has(clean)) return ROLE_BY_SITE_NICK.get(clean);
  if (ROLE_ALIASES.has(clean)) return ROLE_ALIASES.get(clean);
  return "guest";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function getMapPanelRect() {
  const raw = gamePublic?.mapRect || {};
  return {
    x: clamp01(raw.x ?? 0.07),
    y: clamp01(raw.y ?? 0.55),
    w: Math.max(0.05, Math.min(1, Number(raw.w ?? 0.86))),
    h: Math.max(0.05, Math.min(1, Number(raw.h ?? 0.39)))
  };
}

// mapRect \u0438\u0437 Godot \u0437\u0430\u0434\u0430\u0451\u0442 \u0432\u043D\u0435\u0448\u043D\u044E\u044E \u0448\u0438\u0440\u043E\u043A\u0443\u044E \u043F\u0430\u043D\u0435\u043B\u044C. \u0421\u0430\u043C \u043F\u043B\u0430\u043D \u0432\u043D\u0443\u0442\u0440\u0438 \u043D\u0435\u0451
// \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442 \u0440\u0435\u0430\u043B\u044C\u043D\u043E\u0435 \u0441\u043E\u043E\u0442\u043D\u043E\u0448\u0435\u043D\u0438\u0435 \u0441\u0442\u043E\u0440\u043E\u043D \u043A\u043E\u043C\u043D\u0430\u0442\u044B \u0438 \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u0440\u0430\u0441\u0442\u044F\u0433\u0438\u0432\u0430\u0435\u0442\u0441\u044F.
function getMapRect() {
  const panel = getMapPanelRect();
  const wrap = document.getElementById("videoWrap");
  const wrapWidth = Math.max(1, wrap?.clientWidth || 1600);
  const wrapHeight = Math.max(1, wrap?.clientHeight || 900);
  const roomAspect = Math.max(0.25, Number(gamePublic?.map?.aspect || 1));

  const panelPxW = panel.w * wrapWidth;
  const panelPxH = panel.h * wrapHeight;
  let floorPxW = panelPxW;
  let floorPxH = floorPxW / roomAspect;

  if (floorPxH > panelPxH) {
    floorPxH = panelPxH;
    floorPxW = floorPxH * roomAspect;
  }

  const w = floorPxW / wrapWidth;
  const h = floorPxH / wrapHeight;
  return {
    x: panel.x + (panel.w - w) / 2,
    y: panel.y + (panel.h - h) / 2,
    w,
    h
  };
}

function mapLocalFromScreen(x, y) {
  const rect = getMapRect();
  return {
    mapX: clamp01((Number(x) - rect.x) / rect.w),
    mapY: clamp01((Number(y) - rect.y) / rect.h)
  };
}

function screenFromMapLocal(mapX, mapY) {
  const rect = getMapRect();
  return {
    x: rect.x + clamp01(mapX) * rect.w,
    y: rect.y + clamp01(mapY) * rect.h
  };
}

function isOnline(uid) {
  const p = state?.presence?.get?.(uid);
  if (!p) return true;
  const ts = Number(p.ts || 0);
  return p.state !== "offline" && (!ts || Date.now() - ts < 30000);
}

function isHostParticipant(uid, name) {
  return String(uid) === "host_leha" || detectRole(name, uid) === "leha" || Boolean(window.__ccIsHostName?.(name));
}

function allParticipants() {
  const result = [];
  const pointSource = bridgePointsBound ? bridgePoints : state?.points;
  if (!pointSource?.entries) return result;

  for (const [uid, raw] of pointSource.entries()) {
    const point = raw || {};
    if (!rowMatchesCurrentRun(point)) continue;
    if (gamePublic?.requireAdmission) {
      const entrance = entranceRequests.get(uid);
      if (!entrance || String(entrance.status || "waiting") !== "admitted") continue;
    }
    const presence = state.presence?.get?.(uid) || {};
    const name = String(point.name || presence.name || "\u0427\u0443\u0436\u043E\u0439");
    const role = detectRole(name, uid);
    let mapX = Number(point.mapX);
    let mapY = Number(point.mapY);
    if (!Number.isFinite(mapX) || !Number.isFinite(mapY)) {
      const converted = mapLocalFromScreen(point.x ?? 0.5, point.y ?? 0.5);
      mapX = converted.mapX;
      mapY = converted.mapY;
    }

    result.push({
      uid,
      runId: currentRunId(),
      runStartedAt: currentRunStartedAt(),
      role,
      characterName: CHARACTER_NAMES[role] || name,
      name,
      color: String(point.color || presence.color || "#cccccc"),
      emoji: String(point.emoji || presence.emoji || ""),
      x: Number(point.x ?? screenFromMapLocal(mapX, mapY).x),
      y: Number(point.y ?? screenFromMapLocal(mapX, mapY).y),
      mapX: clamp01(mapX),
      mapY: clamp01(mapY),
      moveMode: String(point.moveMode || "walk") === "run" ? "run" : "walk",
      targetId: point.targetId ? String(point.targetId) : null,
      requestedAt: Number(point.requestedAt || point.ts || 0),
      bodyState: String(point.bodyState || "alive").toLowerCase(),
      bodyPresent: point.bodyPresent !== false,
      online: isOnline(uid),
      lastActive: Number(point.lastActive || 0)
    });
  }
  return result;
}

function findParticipant(query = {}) {
  const role = typeof query === "string" ? detectRole(query) : String(query.role || "");
  const wantedName = normalizeName(typeof query === "string" ? query : query.name || "");
  const rows = allParticipants();
  if (role && role !== "guest") {
    const byRole = rows.find(p => p.role === role);
    if (byRole) return byRole;
  }
  if (wantedName) {
    const byName = rows.find(p => normalizeName(p.name) === wantedName);
    if (byName) return byName;
  }
  return null;
}

function sortedGameMessages() {
  return [...gameMessages.entries()]
    .map(([key, value]) => ({ key, ...(value || {}) }))
    .sort((a, b) => Number(a.t || a.createdAt || 0) - Number(b.t || b.createdAt || 0));
}

function sortedEntranceRequests() {
  return [...entranceRequests.entries()]
    .map(([uid, value]) => ({ uid, ...(value || {}) }))
    .filter(rowMatchesCurrentRun)
    .sort((a, b) => Number(a.requestedAt || 0) - Number(b.requestedAt || 0));
}

function getRealChat() {
  try {
    const rows = window.__dpGetRealChat?.();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function buildSnapshot() {
  const chat = [...getRealChat(), ...sortedGameMessages().map(toDisplayMessage)]
    .sort((a, b) => Number(a.t || a.ts || 0) - Number(b.t || b.ts || 0))
    .slice(-60);

  // \u0421\u043D\u0438\u043C\u043A\u0438 \u043A\u0430\u0440\u0442\u044B \u043D\u0443\u0436\u043D\u044B \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430\u043C, \u043D\u043E \u043D\u0435 \u0434\u043E\u043B\u0436\u043D\u044B \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0442\u044C\u0441\u044F \u0432 Godot
  // \u043A\u0430\u0436\u0434\u0443\u044E \u0441\u0435\u043A\u0443\u043D\u0434\u0443 \u043C\u043D\u043E\u0433\u043E\u043C\u0435\u0433\u0430\u0431\u0430\u0439\u0442\u043D\u044B\u043C base64-\u043F\u0430\u043A\u0435\u0442\u043E\u043C.
  const publicForGame = { ...(gamePublic || {}) };
  if (publicForGame.mapCapture) {
    const capture = publicForGame.mapCapture || {};
    publicForGame.mapCapture = {
      ready: Boolean(capture.baseImage && capture.maskImage),
      captureId: String(capture.captureId || ""),
      sceneId: String(capture.sceneId || ""),
      version: Number(capture.version || 1),
      width: Number(capture.width || 0),
      height: Number(capture.height || 0),
      aspect: Number(capture.aspect || 1),
      furnitureCount: Number(capture.furnitureCount || 0)
    };
  }

  return {
    version: 2,
    session: SESSION_KEY,
    now: Date.now(),
    bridge: { version: ADAPTER_VERSION, sentAt: Date.now() },
    runId: currentRunId(),
    runStartedAt: currentRunStartedAt(),
    public: publicForGame,
    players: allParticipants(),
    entities: [...gameEntities.values()],
    entrance: sortedEntranceRequests(),
    traitorVote: traitorVoteState || {},
    chat
  };
}

function toDisplayMessage(message) {
  return {
    key: `game:${message.key || message.id || "unknown"}`,
    uid: "game",
    name: message.maskName || message.name || "\u0427\u0443\u0436\u043E\u0439",
    color: message.maskColor || message.color || "#cccccc",
    emoji: message.maskEmoji || message.emoji || "",
    text: message.text || "",
    t: Number(message.t || message.createdAt || Date.now()),
    gameGenerated: true
  };
}


function injectStyles() {
  if (document.getElementById("dpGameAdapterStyleV5")) return;
  const style = document.createElement("style");
  style.id = "dpGameAdapterStyleV5";
  style.textContent = `
    #dp-game-toast {
      position:fixed; left:50%; top:22px; transform:translateX(-50%) translateY(-12px);
      z-index:300000; max-width:min(820px,calc(100vw - 32px));
      display:flex; gap:11px; align-items:center; padding:12px 16px;
      border-radius:15px; background:rgba(7,12,20,.94); color:white;
      border:1px solid rgba(255,255,255,.16); box-shadow:0 18px 50px rgba(0,0,0,.65);
      opacity:0; pointer-events:none; transition:.18s ease;
      font:700 20px/1.3 'Open Sans',system-ui,sans-serif;
    }
    #dp-game-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
    #dp-game-toast .dp-toast-avatar { font-size:30px; }
    #dp-game-private {
      position:fixed; inset:0; z-index:350000; display:none; place-items:center;
      background:rgba(0,0,0,.74); color:#fff; padding:24px;
      font-family:'Open Sans',system-ui,sans-serif;
    }
    #dp-game-private.show { display:grid; }
    #dp-game-private .card {
      max-width:680px; padding:28px; border-radius:18px; text-align:center;
      background:#0b111b; border:1px solid rgba(255,84,127,.65);
      box-shadow:0 0 50px rgba(255,84,127,.24); font-size:24px;
    }
    #dp-game-private button { margin-top:20px; padding:10px 18px; cursor:pointer; }
    #dp-game-entry {
      display:none; width:100%; margin-top:10px; color:#fff;
      font-family:'Open Sans',system-ui,sans-serif;
      pointer-events:auto;
    }
    #dp-game-entry.show { display:block; }
    #dp-game-entry .card {
      width:100%; padding:11px 12px; text-align:left;
      border-radius:12px; background:rgba(7,12,20,.94);
      border:1px solid rgba(255,255,255,.14);
      box-shadow:0 12px 30px rgba(0,0,0,.45);
    }
    #dp-game-entry .title { font-size:14px; font-weight:950; letter-spacing:.06em; }
    #dp-game-entry .status {
      margin-top:5px; min-height:0; color:rgba(255,255,255,.65);
      font-size:12px; line-height:1.35;
    }
    #dp-game-entry button {
      width:100%; margin-top:9px; padding:9px 12px; border-radius:9px;
      border:1px solid rgba(255,255,255,.22); background:#5b1d24; color:#fff;
      font:900 14px/1.2 'Open Sans',system-ui,sans-serif; cursor:pointer;
    }
    #dp-game-entry button:disabled { cursor:default; opacity:.58; }
    #dpGameMapViewport.dp-map-readonly { cursor:default !important; }
    #dpGameMapViewport.dp-viewer-dead {
      position:relative; overflow:hidden; cursor:default !important;
      background:#020203 !important;
    }
    #dpGameMapViewport.dp-viewer-dead #dpGameMapFloor {
      visibility:hidden !important; opacity:0 !important; pointer-events:none !important;
    }
    #dpMapDeathOverlay {
      position:absolute; inset:0; z-index:2147483000; display:none; place-items:center;
      overflow:hidden; background:#050505; color:#eee; pointer-events:auto; isolation:isolate;
    }
    #dpMapDeathOverlay.show { display:grid !important; }
    #dpMapDeathOverlay::before {
      content:""; position:absolute; inset:-35%; opacity:.92;
      background:
        repeating-radial-gradient(circle at 17% 31%, #fff 0 1px, transparent 1px 4px),
        repeating-linear-gradient(0deg, rgba(255,255,255,.18) 0 1px, rgba(0,0,0,.2) 1px 3px),
        repeating-linear-gradient(90deg, rgba(255,255,255,.08) 0 1px, transparent 1px 5px);
      background-size:7px 9px,100% 4px,11px 100%;
      mix-blend-mode:screen; filter:contrast(2.2) brightness(.72);
      animation:dpDeadNoise .14s steps(2,end) infinite;
    }
    #dpMapDeathOverlay::after {
      content:""; position:absolute; inset:0;
      background:radial-gradient(circle at center, transparent 8%, rgba(0,0,0,.88) 76%),
                 repeating-linear-gradient(0deg, transparent 0 3px, rgba(0,0,0,.42) 3px 5px);
    }
    #dpMapDeathOverlay .dp-map-dead-word {
      position:relative; z-index:2; font:1000 clamp(42px,11vw,94px)/.9 'Open Sans',system-ui,sans-serif;
      letter-spacing:.08em; text-shadow:3px 0 #7a0018,-3px 0 #00596b,0 0 22px #000;
      transform:rotate(-2deg); user-select:none;
    }
    #dpMapDeathOverlay .dp-map-dead-note {
      position:absolute; z-index:2; left:12%; right:12%; bottom:12%;
      text-align:center; color:rgba(255,255,255,.55);
      font:800 11px/1.35 'Open Sans',system-ui,sans-serif; letter-spacing:.12em;
      text-transform:uppercase;
    }
    #dpGameMapFloor .dp-map-capture-base,
    #dpGameMapFloor .dp-map-capture-tint {
      position:absolute; inset:0; width:100%; height:100%; pointer-events:none;
    }
    #dpGameMapFloor .dp-map-capture-base {
      z-index:1; object-fit:fill;
      filter:grayscale(1) saturate(0) brightness(1.08) contrast(1.10)
             drop-shadow(0 0 1px rgba(220,235,255,.25));
      opacity:.90;
      mix-blend-mode:screen;
    }
    #dpGameMapFloor .dp-map-capture-tint {
      z-index:2; background:var(--dp-map-user-color,#ffffff);
      -webkit-mask-position:center; mask-position:center;
      -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat;
      -webkit-mask-size:100% 100%; mask-size:100% 100%;
      mix-blend-mode:color; opacity:.96;
      filter:saturate(1.12);
    }
    #dpGameMapFloor .dp-map-capture-glow {
      position:absolute; inset:0; z-index:3; pointer-events:none;
      background:var(--dp-map-user-color,#ffffff);
      -webkit-mask-position:center; mask-position:center;
      -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat;
      -webkit-mask-size:100% 100%; mask-size:100% 100%;
      mix-blend-mode:screen; opacity:.08;
    }
    #dpGameMapFloor .dp-map-loading {
      position:absolute; inset:0; z-index:1; display:grid; place-items:center;
      color:rgba(255,255,255,.50); font:900 12px/1.2 'Open Sans',system-ui,sans-serif;
      letter-spacing:.12em; text-transform:uppercase; pointer-events:none;
      background:
        radial-gradient(circle at center, rgba(255,255,255,.035), transparent 55%),
        linear-gradient(180deg, rgba(255,255,255,.015), rgba(0,0,0,.08));
    }
    #dpGameMapFloor .dp-map-target {
      --tc:#ffffff; position:absolute; z-index:6; width:28px; height:28px;
      transform:translate(-50%,-50%); pointer-events:none; border-radius:50%;
      border:2px solid var(--tc);
      box-shadow:0 0 5px var(--tc),0 0 15px var(--tc),inset 0 0 8px var(--tc);
      animation:dpMapTargetPulse 1.05s ease-in-out infinite alternate;
    }
    #dpGameMapFloor .dp-map-target::after {
      content:""; position:absolute; left:50%; top:50%; width:5px; height:5px;
      transform:translate(-50%,-50%); border-radius:50%; background:var(--tc);
      box-shadow:0 0 8px var(--tc);
    }
    @keyframes dpMapTargetPulse {
      from { opacity:.62; transform:translate(-50%,-50%) scale(.82); }
      to { opacity:1; transform:translate(-50%,-50%) scale(1.08); }
    }
    #dpGameMapFloor .dp-map-corpse {
      --cc:#ffffff; position:absolute; z-index:12; width:58px; height:66px;
      transform:translate(-50%,-56%); pointer-events:auto; cursor:pointer;
      display:grid; place-items:center;
      color:var(--cc); background:transparent;
      border:0;
      filter:drop-shadow(0 0 6px var(--cc));
      font:1000 44px/.9 Georgia,'Times New Roman',serif;
      text-shadow:0 2px 5px #000,0 0 15px var(--cc);
      animation:dpCorpsePulse .9s ease-in-out infinite alternate;
      user-select:none; -webkit-user-select:none; touch-action:none;
    }
    @keyframes dpCorpsePulse {
      from { opacity:.72; filter:brightness(.82); }
      to { opacity:1; filter:brightness(1.22); }
    }
    body.native-bridge-mode {
      background:#070b12 !important; color:#fff !important;
      overflow:hidden !important;
    }
    body.native-bridge-mode > *:not(#dp-native-bridge-status):not(#dp-game-toast):not(#dp-game-private) {
      display:none !important;
    }
    #dp-native-bridge-status {
      position:fixed; inset:0; z-index:400000; display:none;
      place-items:center; padding:30px; background:#070b12; color:#e8f7ff;
      font:700 18px/1.45 'Open Sans',system-ui,sans-serif;
    }
    body.native-bridge-mode #dp-native-bridge-status { display:grid; }
    #dp-native-bridge-status .card {
      width:min(680px,calc(100vw - 40px)); padding:28px; border-radius:18px;
      background:#0d1521; border:1px solid rgba(22,199,183,.4);
      box-shadow:0 18px 70px rgba(0,0,0,.7);
    }
    #dpGameMapFloor.dp-map-dead {
      overflow:hidden; background:#030405 !important; isolation:isolate;
    }
    #dpGameMapFloor .dp-map-dead-screen {
      position:absolute; inset:0; z-index:50; display:grid; place-items:center;
      overflow:hidden; background:#050505; color:#eee; pointer-events:auto;
    }
    #dpGameMapFloor .dp-map-dead-screen::before {
      content:""; position:absolute; inset:-35%; opacity:.88;
      background:
        repeating-radial-gradient(circle at 17% 31%, #fff 0 1px, transparent 1px 4px),
        repeating-linear-gradient(0deg, rgba(255,255,255,.18) 0 1px, rgba(0,0,0,.2) 1px 3px),
        repeating-linear-gradient(90deg, rgba(255,255,255,.08) 0 1px, transparent 1px 5px);
      background-size:7px 9px,100% 4px,11px 100%;
      mix-blend-mode:screen; filter:contrast(2.2) brightness(.72);
      animation:dpDeadNoise .14s steps(2,end) infinite;
    }
    #dpGameMapFloor .dp-map-dead-screen::after {
      content:""; position:absolute; inset:0;
      background:radial-gradient(circle at center, transparent 8%, rgba(0,0,0,.82) 76%),
                 repeating-linear-gradient(0deg, transparent 0 3px, rgba(0,0,0,.38) 3px 5px);
    }
    #dpGameMapFloor .dp-map-dead-word {
      position:relative; z-index:2; font:1000 clamp(42px,11vw,94px)/.9 'Open Sans',system-ui,sans-serif;
      letter-spacing:.08em; text-shadow:3px 0 #7a0018,-3px 0 #00596b,0 0 22px #000;
      transform:rotate(-2deg); user-select:none;
    }
    #dpGameMapFloor .dp-map-dead-note {
      position:absolute; z-index:2; left:12%; right:12%; bottom:12%;
      text-align:center; color:rgba(255,255,255,.55);
      font:800 11px/1.35 'Open Sans',system-ui,sans-serif; letter-spacing:.12em;
      text-transform:uppercase;
    }
    @keyframes dpDeadNoise {
      0% { transform:translate3d(-2%,1%,0) scale(1.02); }
      33% { transform:translate3d(3%,-2%,0) scale(1.04); }
      66% { transform:translate3d(-1%,3%,0) scale(1.03); }
      100% { transform:translate3d(2%,-1%,0) scale(1.02); }
    }
    #dp-native-bridge-status .title { font-size:25px; font-weight:950; margin-bottom:12px; }
    #dp-native-bridge-status .state { color:#fbbf24; margin-bottom:10px; }
    #dp-native-bridge-status .ok { color:#34d399; }
    #dp-native-bridge-status .small { color:rgba(255,255,255,.62); font-size:13px; font-weight:600; }
    body.game-host-mode #chatPanel { display:none !important; }
    body.game-host-mode #overlay { display:none !important; pointer-events:none !important; }
    body.game-host-mode #player {
      display:block !important; width:100% !important; height:100% !important;
      min-width:1px !important; min-height:1px !important; background:#000;
    }
    body.game-host-mode .stage { min-width:1px !important; min-height:360px !important; }
    body.game-host-mode .videoWrap {
      display:block !important; width:min(100%, calc((100vh - 20px) * 1.7777778)) !important;
      height:auto !important; min-width:320px !important; min-height:180px !important;
      aspect-ratio:16 / 9 !important;
    }
    #overlay { z-index:30; }
    #fx-layer { z-index:35; }
    #dp-traitor-vote {
      position:fixed; inset:0; z-index:390000; display:none; place-items:center;
      padding:24px; background:rgba(2,5,10,.82); color:#fff;
      font-family:'Open Sans',system-ui,sans-serif; backdrop-filter:blur(9px);
    }
    #dp-traitor-vote.show { display:grid; }
    #dp-traitor-vote .dp-tv-card {
      width:min(760px,calc(100vw - 32px)); padding:26px; border-radius:20px;
      background:linear-gradient(145deg,rgba(15,23,34,.98),rgba(7,12,20,.99));
      border:1px solid rgba(255,74,112,.48);
      box-shadow:0 28px 90px rgba(0,0,0,.74),0 0 46px rgba(255,43,91,.18);
    }
    #dp-traitor-vote h2 { margin:0 0 10px; text-align:center; font-size:34px; }
    #dp-traitor-vote .dp-tv-warning {
      margin:0 auto 20px; max-width:650px; color:rgba(255,255,255,.76);
      text-align:center; font-size:17px; line-height:1.5;
    }
    #dp-traitor-vote .dp-tv-choices {
      display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px;
    }
    #dp-traitor-vote .dp-tv-choice {
      min-height:58px; padding:12px 14px; border-radius:13px; cursor:pointer;
      border:1px solid rgba(255,255,255,.16); color:#fff; text-align:left;
      background:rgba(255,255,255,.055); font:900 18px/1.25 'Open Sans',system-ui,sans-serif;
      transition:transform .12s ease,border-color .12s ease,background .12s ease;
    }
    #dp-traitor-vote .dp-tv-choice:hover:not(:disabled) {
      transform:translateY(-1px); border-color:rgba(255,74,112,.7);
      background:rgba(255,74,112,.12);
    }
    #dp-traitor-vote .dp-tv-choice.selected {
      border-color:#ff4a70; background:rgba(255,74,112,.19);
      box-shadow:0 0 24px rgba(255,74,112,.18);
    }
    #dp-traitor-vote .dp-tv-choice:disabled { cursor:default; opacity:.72; }
    #dp-traitor-vote .dp-tv-status {
      margin-top:18px; min-height:24px; text-align:center;
      color:#fbbf24; font-weight:850;
    }
    #dp-traitor-vote .dp-tv-result {
      display:none; margin-top:18px; padding:18px; border-radius:14px;
      background:rgba(0,0,0,.28); border:1px solid rgba(255,255,255,.12);
      text-align:center; font-size:20px; line-height:1.55;
    }
    #dp-traitor-vote.reveal .dp-tv-result { display:block; }
    #dp-traitor-vote .dp-tv-close {
      display:none; margin:18px auto 0; padding:10px 18px; border-radius:10px;
      border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.08);
      color:#fff; cursor:pointer; font-weight:850;
    }
    #dp-traitor-vote.reveal .dp-tv-close { display:block; }
    body.native-bridge-mode #dp-traitor-vote,
    body.game-host-mode #dp-traitor-vote { display:none !important; }
    @media (max-width:620px) {
      #dp-traitor-vote .dp-tv-choices { grid-template-columns:1fr; }
      #dp-traitor-vote h2 { font-size:28px; }
    }
  `;
  document.head.appendChild(style);
}

function ensureUi() {
  injectStyles();
  let toast = document.getElementById("dp-game-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "dp-game-toast";
    document.body.appendChild(toast);
  }
  let privateLayer = document.getElementById("dp-game-private");
  if (!privateLayer) {
    privateLayer = document.createElement("div");
    privateLayer.id = "dp-game-private";
    privateLayer.innerHTML = `<div class="card"><div class="text"></div><button type="button">\u042F \u0443\u0432\u0438\u0434\u0435\u043B(\u0430)</button></div>`;
    privateLayer.querySelector("button").addEventListener("click", () => privateLayer.classList.remove("show"));
    document.body.appendChild(privateLayer);
  }
  let traitorLayer = document.getElementById("dp-traitor-vote");
  if (!traitorLayer) {
    traitorLayer = document.createElement("div");
    traitorLayer.id = "dp-traitor-vote";
    traitorLayer.innerHTML = `
      <div class="dp-tv-card">
        <h2>Кто предатель?</h2>
        <div class="dp-tv-warning"></div>
        <div class="dp-tv-choices"></div>
        <div class="dp-tv-status"></div>
        <div class="dp-tv-result"></div>
        <button class="dp-tv-close" type="button">Я увидел(а)</button>
      </div>`;
    traitorLayer.querySelector(".dp-tv-close")?.addEventListener("click", () => {
      dismissedTraitorRevealAt = Number(
        traitorVoteState?.revealedAt || traitorVoteState?.finishedAt || Date.now()
      );
      traitorLayer.classList.remove("show");
    });
    document.body.appendChild(traitorLayer);
  }

  let entryLayer = document.getElementById("dp-game-entry");
  if (!entryLayer) {
    entryLayer = document.createElement("div");
    entryLayer.id = "dp-game-entry";
    entryLayer.innerHTML = `
      <div class="card">
        <div class="title">\u0422\u042B \u041F\u041E\u041A\u0410 \u0421\u041D\u0410\u0420\u0423\u0416\u0418</div>
        <div class="status">\u041C\u043E\u0436\u043D\u043E \u043D\u0430\u0431\u043B\u044E\u0434\u0430\u0442\u044C \u0437\u0430 \u043A\u0430\u0440\u0442\u043E\u0439 \u0438\u043B\u0438 \u043F\u043E\u0441\u0442\u0443\u0447\u0430\u0442\u044C \u0432 \u0434\u0432\u0435\u0440\u044C.</div>
        <button type="button">\u0412\u041E\u0419\u0422\u0418</button>
      </div>`;
    entryLayer.querySelector("button").addEventListener("click", () => void handleEntranceButton());
  }

  // \u041A\u0430\u0440\u0442\u0430 \u0441\u043E\u0437\u0434\u0430\u0451\u0442\u0441\u044F \u0441\u0430\u043C\u0438\u043C index.html. \u0415\u0441\u043B\u0438 \u0430\u0434\u0430\u043F\u0442\u0435\u0440 \u0443\u0441\u043F\u0435\u043B \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C\u0441\u044F \u0440\u0430\u043D\u044C\u0448\u0435 \u043D\u0435\u0451,
  // \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u043C\u043E\u0433\u043B\u0430 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043F\u043E\u043F\u0430\u0441\u0442\u044C \u0432 body. \u041F\u0440\u0438 \u043A\u0430\u0436\u0434\u043E\u043C ensureUi \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u043C \u0435\u0451
  // \u0432\u043D\u0443\u0442\u0440\u044C \u043E\u043A\u043D\u0430 \u043A\u0430\u0440\u0442\u044B, \u0447\u0442\u043E\u0431\u044B \u00AB\u0412\u043E\u0439\u0442\u0438\u00BB \u043D\u0438\u043A\u043E\u0433\u0434\u0430 \u043D\u0435 \u043F\u0435\u0440\u0435\u043A\u0440\u044B\u0432\u0430\u043B\u043E \u0432\u0435\u0441\u044C \u0441\u0430\u0439\u0442.
  const mapBody = document.getElementById("dpGameMapBody");
  if (mapBody && entryLayer.parentElement !== mapBody) {
    mapBody.appendChild(entryLayer);
  } else if (!entryLayer.parentElement) {
    document.body.appendChild(entryLayer);
  }
}

let toastTimer = null;
function showGameToast(message) {
  ensureUi();
  const toast = document.getElementById("dp-game-toast");
  const emoji = message.emoji || "\uD83D\uDCAC";
  const name = message.name || "\u0427\u0443\u0436\u043E\u0439";
  toast.innerHTML = `<span class="dp-toast-avatar">${escapeHtml(emoji)}</span><span><b style="color:${escapeHtml(message.color || "#fff")}">${escapeHtml(name)}:</b> ${escapeHtml(message.text || "")}</span>`;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4200);
}

function showPrivateEvent(event) {
  ensureUi();
  const text = event.text || "Ты что-то увидел(а).";
  const layer = document.getElementById("dp-game-private");
  layer.querySelector(".text").textContent = text;
  layer.classList.add("show");

  // Личная подсказка остаётся только у адресата, но ещё дублируется в его
  // локальном чате — так цифру можно перечитать после закрытия окна.
  const privateKey = `private_${String(event.key || Date.now())}`;
  renderGameMessage(privateKey, {
    name: "КОМНАТА",
    text,
    color: "#ff547f",
    emoji: "🔒"
  }, false);
}


function normalizeIdList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || "")).filter(Boolean);
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, enabled]) => enabled !== false && enabled !== null)
      .map(([key, raw]) => {
        if (typeof raw === "string") return raw;
        if (raw && typeof raw === "object" && raw.uid) return String(raw.uid);
        return String(key);
      })
      .filter(Boolean);
  }
  return [];
}

function normalizeCandidates(value) {
  const rows = Array.isArray(value)
    ? value
    : (value && typeof value === "object" ? Object.values(value) : []);
  return rows
    .filter(row => row && typeof row === "object")
    .map(row => ({
      characterId: String(row.characterId || row.uid || ""),
      role: String(row.role || "guest"),
      name: String(row.name || row.displayName || row.role || "Чужой"),
      color: String(row.color || "#ffffff")
    }))
    .filter(row => row.characterId && row.role);
}

function currentViewerTraitorVote() {
  const identity = currentViewerIdentity();
  const votes = traitorVoteState?.votes || {};
  return votes && typeof votes === "object" ? (votes[identity.uid] || null) : null;
}

async function submitTraitorVote(candidate) {
  if (!db || IS_GAME_CONTROLLER || !candidate) return;
  const identity = currentViewerIdentity();
  if (!identity.uid || window.__ccIsHostName?.(identity.name)) return;
  const eligible = normalizeIdList(traitorVoteState?.eligibleVoterIds);
  if (!eligible.includes(identity.uid)) return;
  if (String(traitorVoteState?.phase || "") !== "voting") return;
  if (currentViewerTraitorVote()) return;

  const vote = {
    uid: identity.uid,
    voterName: identity.name,
    candidateId: String(candidate.characterId || ""),
    candidateRole: String(candidate.role || "guest"),
    candidateName: String(candidate.name || candidate.role || "Чужой"),
    runId: String(traitorVoteState?.runId || currentRunId()),
    createdAt: Date.now(),
    t: serverTimestamp()
  };

  traitorVoteState = {
    ...(traitorVoteState || {}),
    votes: { ...(traitorVoteState?.votes || {}), [identity.uid]: vote }
  };
  renderTraitorVote();
  try {
    await set(ref(db, `${TRAITOR_VOTE_PATH}/votes/${identity.uid}`), vote);
  } catch (error) {
    console.error("[DP game] traitor vote failed", error);
    const votes = { ...(traitorVoteState?.votes || {}) };
    delete votes[identity.uid];
    traitorVoteState = { ...(traitorVoteState || {}), votes };
    renderTraitorVote();
  }
}

function renderTraitorVote() {
  ensureUi();
  const layer = document.getElementById("dp-traitor-vote");
  if (!layer) return;
  if (IS_GAME_CONTROLLER || !auth?.currentUser || !state?.authed) {
    layer.classList.remove("show", "reveal");
    return;
  }

  const identity = currentViewerIdentity();
  const isHost = Boolean(window.__ccIsHostName?.(identity.name));
  const voteRunId = String(traitorVoteState?.runId || "");
  const activeRun = String(currentRunId() || gamePublic?.runId || "");
  const phase = String(traitorVoteState?.phase || "idle");
  const active = Boolean(traitorVoteState?.active);
  const eligible = normalizeIdList(traitorVoteState?.eligibleVoterIds);
  const isEligible = eligible.includes(identity.uid);

  if (!active || isHost || !isEligible || (voteRunId && activeRun && voteRunId !== activeRun)) {
    layer.classList.remove("show", "reveal");
    return;
  }
  const revealStamp = Number(traitorVoteState?.revealedAt || traitorVoteState?.finishedAt || 0);
  if ((phase === "reveal" || phase === "finished") && revealStamp > 0 && revealStamp === dismissedTraitorRevealAt) {
    layer.classList.remove("show");
    return;
  }

  const candidates = normalizeCandidates(traitorVoteState?.candidates);
  const myVote = currentViewerTraitorVote();
  const choices = layer.querySelector(".dp-tv-choices");
  const warning = layer.querySelector(".dp-tv-warning");
  const statusEl = layer.querySelector(".dp-tv-status");
  const resultEl = layer.querySelector(".dp-tv-result");
  const titleEl = layer.querySelector("h2");
  if (!choices || !warning || !statusEl || !resultEl || !titleEl) return;

  titleEl.textContent = String(traitorVoteState?.title || "Кто предатель?");
  warning.textContent = String(
    traitorVoteState?.warning ||
    "Если вы правы, вы проживёте дольше. Если нет — выбранный Лёхой человек лишится одной руки помощи."
  );

  choices.replaceChildren();
  for (const candidate of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dp-tv-choice";
    button.textContent = candidate.name;
    button.style.borderColor = `${candidate.color}66`;
    const selected = String(myVote?.candidateRole || "") === candidate.role;
    if (selected) button.classList.add("selected");
    button.disabled = Boolean(myVote) || phase !== "voting";
    button.addEventListener("click", () => void submitTraitorVote(candidate));
    choices.appendChild(button);
  }

  layer.classList.add("show");
  layer.classList.toggle("reveal", phase === "reveal" || phase === "finished");

  if (phase === "voting") {
    statusEl.textContent = myVote
      ? `Твой голос: ${String(myVote.candidateName || myVote.candidateRole || "принят")}. Ждём остальных.`
      : "Выбери одного человека. После отправки изменить голос нельзя.";
    resultEl.textContent = "";
  } else if (phase === "host_choice") {
    statusEl.textContent = "Все голоса собраны. Теперь выбирает Лёха.";
    resultEl.textContent = "";
  } else {
    const majorityName = String(traitorVoteState?.majorityName || "Никто");
    const hostChoiceName = String(traitorVoteState?.hostChoiceName || "неизвестно кого");
    const penaltyText = String(
      traitorVoteState?.penaltyText || `${hostChoiceName} лишится одной руки помощи.`
    );
    statusEl.textContent = "Решение принято.";
    resultEl.innerHTML = `
      <div><b>Большинство выбрало:</b> ${escapeHtml(majorityName)}</div>
      <div><b>Лёха выбрал:</b> ${escapeHtml(hostChoiceName)}</div>
      <div style="margin-top:10px;color:#ff9bad">${escapeHtml(penaltyText)}</div>`;
  }
}

function currentViewerIdentity() {
  const uid = window.__ccCanonicalUid?.() || auth?.currentUser?.uid || "";
  const rawName = state?.name || window.ccStorage?.getItem?.("cc_name") || "\u0427\u0443\u0436\u043E\u0439";
  const name = window.__ccCanonicalName?.(rawName) || rawName || "\u0427\u0443\u0436\u043E\u0439";
  const isHostSelf = Boolean(window.__ccIsHostName?.(name));
  return {
    uid,
    name,
    role: detectRole(name, uid),
    color: isHostSelf ? (window.HOST_IDENTITY?.color || "#1e40af") : String(state?.color || "#16c7b7"),
    emoji: isHostSelf ? (window.HOST_IDENTITY?.emoji || "") : String(state?.emoji || "")
  };
}

function runtimeFromEntry(entry) {
  const uid = String(entry?.uid || "");
  const runtime = uid ? (runtimeStates.get(uid) || {}) : {};
  return {
    bodyState: String(runtime.bodyState ?? entry?.bodyState ?? "alive").toLowerCase(),
    controllerState: String(runtime.controllerState ?? entry?.controllerState ?? "attached").toLowerCase(),
    exitRequested: Boolean(runtime.exitRequested ?? entry?.exitRequested),
    bodyPresent: (runtime.bodyPresent ?? entry?.bodyPresent) !== false
  };
}

function isDeadBodyState(value) {
  return ["dying", "dead", "being_helped", "reviving"].includes(String(value || "").toLowerCase());
}

function currentViewerEntry() {
  const identity = currentViewerIdentity();
  if (!identity.uid) return null;
  const entry = entranceRequests.get(identity.uid);
  if (entry) return entry;
  const runtime = runtimeStates.get(identity.uid);
  return runtime ? { uid: identity.uid, ...identity, status: "admitted", ...runtime } : null;
}

function isCurrentViewerDead() {
  return isDeadBodyState(runtimeFromEntry(currentViewerEntry()).bodyState);
}


function canCurrentViewerSeeMap() {
  const inputMode = String(gamePublic?.inputMode || "map").toLowerCase();
  const inputAllowsMap = ["map", "both", "dual", "map_and_vote", "vote_and_map"].includes(inputMode);
  const localBridgeAlive = (
    lastLocalControllerPulseAt > 0 &&
    Date.now() - lastLocalControllerPulseAt <= LOCAL_STATE_STALE_MS
  );
  return Boolean(
    !IS_GAME_CONTROLLER &&
    auth?.currentUser &&
    state?.authed &&
    inputAllowsMap &&
    (gamePublic?.active || localBridgeAlive)
  );
}

function canCurrentViewerUseMap() {
  if (!canCurrentViewerSeeMap()) return false;
  const entry = currentViewerEntry();
  const runtime = runtimeFromEntry(entry);
  if (isDeadBodyState(runtime.bodyState)) return false;
  if (runtime.controllerState === "detached" || runtime.exitRequested) return false;
  if (!gamePublic?.requireAdmission) return true;
  return String(entry?.status || "") === "admitted";
}

async function handleEntranceButton() {
  const identity = currentViewerIdentity();
  const entry = identity.uid ? entranceRequests.get(identity.uid) : null;
  const exitCompleted = Boolean(identity.uid && completedExitTombstones.has(identity.uid));
  const status = exitCompleted ? "outside" : String(entry?.status || "");
  const runtime = runtimeFromEntry(entry);
  if (runtime.bodyPresent && isDeadBodyState(runtime.bodyState) && (runtime.exitRequested || runtime.controllerState === "detached")) {
    await requestReturnToBody();
    return;
  }
  if (status === "admitted") {
    await requestExit();
    return;
  }
  await requestEntrance();
}

async function requestEntrance() {
  if (IS_GAME_CONTROLLER || !auth?.currentUser || !state?.authed || !gamePublic?.active) return;
  const identity = currentViewerIdentity();
  if (!identity.uid) return;
  const existing = entranceRequests.get(identity.uid) || {};
  const completedExit = completedExitTombstones.has(identity.uid);
  if (!completedExit && ["approaching", "waiting", "entering", "admitted", "leaving"].includes(String(existing.status || ""))) return;
  completedExitTombstones.delete(identity.uid);

  const request = {
    ...identity,
    status: "approaching",
    doorOpenBlocked: false,
    bodyState: "alive",
    controllerState: "attached",
    exitRequested: false,
    bodyPresent: true,
    requestedAt: Date.now(),
    sceneId: String(gamePublic.sceneId || ""),
    runId: currentRunId(),
    runStartedAt: currentRunStartedAt()
  };
  entranceRequests.set(identity.uid, request);
  renderAdmissionUi();
  scheduleSnapshotToGame();
  try { await remove(ref(db, `${GAME_POINTS_PATH}/${identity.uid}`)); } catch {}
  bridgePoints.delete(identity.uid);
  try { await set(ref(db, `${ENTRANCE_PATH}/${identity.uid}`), request); }
  catch (error) { console.warn("[DP game] entrance request failed", error); }
}

async function requestExit() {
  if (IS_GAME_CONTROLLER || !auth?.currentUser || !state?.authed || !gamePublic?.active) return;
  const identity = currentViewerIdentity();
  if (!identity.uid) return;
  const existing = entranceRequests.get(identity.uid) || {};
  if (String(existing.status || "") !== "admitted") return;

  const runtime = runtimeFromEntry(existing);
  if (isDeadBodyState(runtime.bodyState)) {
    const request = {
      ...existing,
      ...identity,
      status: "admitted",
      controllerState: "detached",
      exitRequested: true,
      bodyPresent: true,
      leaveRequestedAt: Date.now(),
      sceneId: String(gamePublic.sceneId || ""),
      runId: currentRunId(),
      runStartedAt: currentRunStartedAt()
    };
    entranceRequests.set(identity.uid, request);
    renderAdmissionUi();
    renderMap();
    scheduleSnapshotToGame();
    try { await update(ref(db, `${ENTRANCE_PATH}/${identity.uid}`), request); }
    catch (error) { console.warn("[DP game] dead exit request failed", error); }
    return;
  }

  const point = bridgePoints.get(identity.uid) || {};
  const request = {
    ...existing,
    ...identity,
    status: "leaving",
    targetId: null,
    doorOpenBlocked: false,
    controllerState: "detached",
    exitRequested: true,
    bodyPresent: true,
    leaveRequestedAt: Date.now(),
    requestedAt: Number(existing.requestedAt || Date.now()),
    mapX: clamp01(point.mapX ?? existing.mapX ?? gamePublic?.entrySpawn?.mapX ?? 0.5),
    mapY: clamp01(point.mapY ?? existing.mapY ?? gamePublic?.entrySpawn?.mapY ?? 0.88),
    sceneId: String(gamePublic.sceneId || ""),
    runId: currentRunId(),
    runStartedAt: currentRunStartedAt()
  };
  entranceRequests.set(identity.uid, request);
  renderAdmissionUi();
  renderMap();
  scheduleSnapshotToGame();
  try { await update(ref(db, `${ENTRANCE_PATH}/${identity.uid}`), request); }
  catch (error) { console.warn("[DP game] exit request failed", error); }
}

async function requestReturnToBody() {
  if (IS_GAME_CONTROLLER || !auth?.currentUser || !state?.authed || !gamePublic?.active) return;
  const identity = currentViewerIdentity();
  if (!identity.uid) return;
  const existing = entranceRequests.get(identity.uid) || {};
  const runtime = runtimeFromEntry(existing);
  if (!runtime.bodyPresent || !isDeadBodyState(runtime.bodyState)) return;

  const request = {
    ...existing,
    ...identity,
    status: "admitted",
    controllerState: "attached",
    exitRequested: false,
    bodyPresent: true,
    returnedAt: Date.now(),
    sceneId: String(gamePublic.sceneId || ""),
    runId: currentRunId(),
    runStartedAt: currentRunStartedAt()
  };
  entranceRequests.set(identity.uid, request);
  renderAdmissionUi();
  renderMap();
  scheduleSnapshotToGame();
  try { await update(ref(db, `${ENTRANCE_PATH}/${identity.uid}`), request); }
  catch (error) { console.warn("[DP game] return to body failed", error); }
}

async function ensureAdmittedPoint(entry) {
  const identity = currentViewerIdentity();
  if (!identity.uid || String(entry?.status || "") !== "admitted") return;
  const stamp = String(entry.admittedAt || entry.requestedAt || "admitted");
  const key = `${identity.uid}:${stamp}`;
  if (admissionSpawnWritten.has(key)) return;
  admissionSpawnWritten.add(key);
  const spawn = gamePublic?.entrySpawn || {};
  await submitMapPoint(
    clamp01(entry.mapX ?? spawn.mapX ?? 0.5),
    clamp01(entry.mapY ?? spawn.mapY ?? 0.88),
    "walk",
    true
  );
}

function renderAdmissionUi() {
  ensureUi();
  const layer = document.getElementById("dp-game-entry");
  if (!layer) return;
  if (IS_GAME_CONTROLLER || !gamePublic?.active || !gamePublic?.requireAdmission) {
    layer.classList.remove("show");
    return;
  }

  const identity = currentViewerIdentity();
  const entry = identity.uid ? entranceRequests.get(identity.uid) : null;
  const status = identity.uid && completedExitTombstones.has(identity.uid)
    ? "outside"
    : String(entry?.status || "");
  const runtime = runtimeFromEntry(entry);
  const dead = isDeadBodyState(runtime.bodyState);
  const button = layer.querySelector("button");
  const statusEl = layer.querySelector(".status");
  const titleEl = layer.querySelector(".title");

  layer.classList.add("show");
  if (runtime.bodyPresent && dead && (runtime.exitRequested || runtime.controllerState === "detached")) {
    titleEl.textContent = "\u0422\u0412\u041E\u0401 \u0422\u0415\u041B\u041E \u041E\u0421\u0422\u0410\u041B\u041E\u0421\u042C \u0412 \u041A\u041E\u041C\u041D\u0410\u0422\u0415";
    button.disabled = false;
    button.textContent = "\u0412\u0415\u0420\u041D\u0423\u0422\u042C\u0421\u042F";
    statusEl.textContent = "\u0422\u044B \u0432\u0435\u0440\u043D\u0451\u0448\u044C\u0441\u044F \u0432 \u0438\u0433\u0440\u0443 \u043D\u0430 \u043C\u0435\u0441\u0442\u0435 \u0441\u043C\u0435\u0440\u0442\u0438, \u043D\u043E \u043E\u0441\u0442\u0430\u043D\u0435\u0448\u044C\u0441\u044F \u043C\u0451\u0440\u0442\u0432\u044B\u043C \u0434\u043E \u043F\u043E\u043C\u043E\u0449\u0438.";
  } else if (runtime.bodyPresent && dead) {
    titleEl.textContent = "\u0422\u042B \u041C\u0401\u0420\u0422\u0412";
    button.disabled = false;
    button.textContent = "\u0412\u042B\u0419\u0422\u0418";
    statusEl.textContent = "\u0422\u0435\u043B\u043E \u043E\u0441\u0442\u0430\u043D\u0435\u0442\u0441\u044F \u0432 \u043A\u043E\u043C\u043D\u0430\u0442\u0435. \u041F\u043E\u0441\u043B\u0435 \u043E\u0436\u0438\u0432\u043B\u0435\u043D\u0438\u044F \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u0436 \u0441\u0430\u043C \u0443\u0439\u0434\u0451\u0442.";
  } else if (status === "admitted") {
    titleEl.textContent = "\u0422\u042B \u0412 \u041A\u041E\u041C\u041D\u0410\u0422\u0415";
    button.disabled = false;
    button.textContent = "\u0412\u042B\u0419\u0422\u0418";
    statusEl.textContent = "\u041F\u0435\u0440\u0441\u043E\u043D\u0430\u0436 \u0443\u0439\u0434\u0451\u0442 \u043E\u0431\u0440\u0430\u0442\u043D\u043E \u0432 \u0442\u0451\u043C\u043D\u044B\u0439 \u043A\u043E\u043D\u0435\u0446 \u043A\u043E\u0440\u0438\u0434\u043E\u0440\u0430.";
    void ensureAdmittedPoint(entry);
  } else if (status === "leaving") {
    titleEl.textContent = "\u0422\u042B \u0423\u0425\u041E\u0414\u0418\u0428\u042C";
    button.disabled = true;
    button.textContent = "\u0418\u0414\u0401\u0428\u042C \u0412 \u041A\u041E\u0420\u0418\u0414\u041E\u0420\u2026";
    statusEl.textContent = "\u041F\u0435\u0440\u0441\u043E\u043D\u0430\u0436 \u0432\u044B\u0439\u0434\u0435\u0442 \u0437\u0430 \u0434\u0432\u0435\u0440\u044C \u0438 \u0434\u043E\u0439\u0434\u0451\u0442 \u0434\u043E \u0434\u0430\u043B\u044C\u043D\u0435\u0439 \u0441\u0442\u0435\u043D\u044B.";
  } else if (status === "entering") {
    titleEl.textContent = "\u0422\u0415\u0411\u042F \u0412\u041F\u0423\u0421\u041A\u0410\u042E\u0422";
    button.disabled = true;
    button.textContent = "\u0412\u0425\u041E\u0414\u0418\u0428\u042C\u2026";
    statusEl.textContent = "\u041B\u0451\u0445\u0430 \u043E\u0442\u043A\u0440\u044B\u043B \u0434\u0432\u0435\u0440\u044C. \u041F\u0435\u0440\u0441\u043E\u043D\u0430\u0436 \u0441\u0435\u0439\u0447\u0430\u0441 \u0437\u0430\u0439\u0434\u0451\u0442 \u0432 \u043A\u043E\u043C\u043D\u0430\u0442\u0443.";
  } else if (status === "waiting") {
    titleEl.textContent = "\u0422\u042B \u0423 \u0414\u0412\u0415\u0420\u0418";
    button.disabled = true;
    button.textContent = "\u0416\u0414\u0401\u041C, \u041F\u041E\u041A\u0410 \u041E\u0422\u041A\u0420\u041E\u042E\u0422";
    statusEl.textContent = entry?.doorOpenBlocked
      ? "\u0425\u043E\u0440\u043E\u0448\u0438\u0435 \u0433\u043E\u0441\u0442\u0438 \u0441\u043D\u0430\u0447\u0430\u043B\u0430 \u0441\u0442\u0443\u0447\u0430\u0442."
      : "\u0422\u044B \u043F\u043E\u0441\u0442\u0443\u0447\u0430\u043B(\u0430). \u041A\u0430\u0440\u0442\u0443 \u043C\u043E\u0436\u043D\u043E \u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C, \u043D\u043E \u0434\u0432\u0438\u0433\u0430\u0442\u044C\u0441\u044F \u043F\u043E\u043A\u0430 \u043D\u0435\u043B\u044C\u0437\u044F.";
  } else if (status === "approaching") {
    titleEl.textContent = "\u0422\u042B \u0412 \u041A\u041E\u0420\u0418\u0414\u041E\u0420\u0415";
    button.disabled = true;
    button.textContent = "\u0418\u0414\u0401\u0428\u042C \u041A \u0414\u0412\u0415\u0420\u0418\u2026";
    statusEl.textContent = "\u041F\u0435\u0440\u0441\u043E\u043D\u0430\u0436 \u043F\u043E\u044F\u0432\u0438\u043B\u0441\u044F \u0443 \u0434\u0430\u043B\u044C\u043D\u0435\u0439 \u0441\u0442\u0435\u043D\u044B \u0438 \u0441\u0430\u043C \u0438\u0434\u0451\u0442 \u0441\u0442\u0443\u0447\u0430\u0442\u044C.";
  } else {
    titleEl.textContent = "\u0422\u042B \u041F\u041E\u041A\u0410 \u0421\u041D\u0410\u0420\u0423\u0416\u0418";
    button.disabled = false;
    button.textContent = "\u0412\u041E\u0419\u0422\u0418";
    statusEl.textContent = "\u041F\u043E\u044F\u0432\u0438\u0442\u044C\u0441\u044F \u0432 \u0442\u0435\u043C\u043D\u043E\u0442\u0435 \u043A\u043E\u0440\u0438\u0434\u043E\u0440\u0430 \u0438 \u043F\u043E\u0439\u0442\u0438 \u043A \u0434\u0432\u0435\u0440\u0438.";
  }
}


let mapRenderQueued = false;
let mapClickBound = false;

function getMapObjects() {
  return Array.isArray(gamePublic?.map?.objects) ? gamePublic.map.objects : [];
}

function getVisibleHelpTargets() {
  const merged = new Map();
  const publicTargets = Array.isArray(gamePublic?.helpTargets)
    ? gamePublic.helpTargets
    : Object.values(gamePublic?.helpTargets || {});

  for (const target of publicTargets) {
    const characterId = String(target?.characterId || target?.uid || "");
    if (characterId) merged.set(characterId, target || {});
  }
  for (const target of helpTargets.values()) {
    const characterId = String(target?.characterId || target?.uid || "");
    if (characterId) merged.set(characterId, { ...(merged.get(characterId) || {}), ...(target || {}) });
  }

  // \u0420\u0435\u0437\u0435\u0440\u0432 \u21161: \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0441\u043C\u0435\u0440\u0442\u0438 \u0437\u0440\u0438\u0442\u0435\u043B\u044F \u0445\u0440\u0430\u043D\u0438\u0442\u0441\u044F \u043F\u0440\u044F\u043C\u043E \u0432 \u0435\u0433\u043E \u043E\u0431\u044B\u0447\u043D\u043E\u0439 \u0442\u043E\u0447\u043A\u0435.
  // \u042D\u0442\u0438 \u0442\u043E\u0447\u043A\u0438 \u0438 \u0442\u0430\u043A \u043D\u0430\u0434\u0451\u0436\u043D\u043E \u0434\u043E\u0445\u043E\u0434\u044F\u0442 \u0434\u043E \u0432\u0441\u0435\u0445 \u0432\u043A\u043B\u0430\u0434\u043E\u043A, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u043A\u0440\u0435\u0441\u0442 \u043D\u0435 \u0437\u0430\u0432\u0438\u0441\u0438\u0442
  // \u043E\u0442 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E\u0433\u043E \u043A\u0430\u043D\u0430\u043B\u0430 helpTargets.
  for (const player of allParticipants()) {
    const bodyState = String(player?.bodyState || "alive").toLowerCase();
    if (player?.bodyPresent === false || !["dead", "being_helped"].includes(bodyState)) continue;
    const characterId = String(player?.uid || "");
    if (!characterId) continue;
    merged.set(characterId, {
      ...(merged.get(characterId) || {}),
      characterId,
      displayName: String(player?.name || player?.characterName || characterId),
      bodyState,
      bodyPresent: true,
      color: String(player?.color || "#ffffff"),
      mapX: Number(player?.mapX ?? .5),
      mapY: Number(player?.mapY ?? .5)
    });
  }

  // \u0420\u0435\u0437\u0435\u0440\u0432 \u21162: \u041B\u0451\u0445\u0430 \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u0442\u0441\u044F \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u044B\u043C \u043E\u0431\u044A\u0435\u043A\u0442\u043E\u043C, \u043F\u043E\u0442\u043E\u043C\u0443 \u0447\u0442\u043E \u0443 \u043D\u0435\u0433\u043E \u043D\u0435\u0442
  // \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u0441\u043A\u043E\u0439 \u0442\u043E\u0447\u043A\u0438 \u0432 Firebase.
  const hostCorpse = hostCorpseState || gamePublic?.hostCorpse || null;
  if (hostCorpse && typeof hostCorpse === "object") {
    const characterId = String(hostCorpse.characterId || hostCorpse.uid || "leha");
    merged.set(characterId, { ...(merged.get(characterId) || {}), ...hostCorpse, characterId });
  }

  // \u041B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 runtime \u2014 \u0441\u0430\u043C\u044B\u0439 \u0441\u0432\u0435\u0436\u0438\u0439 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u0438\u0441\u0442\u0438\u043D\u044B. \u041F\u0443\u0431\u043B\u0438\u0447\u043D\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A
  // \u0442\u0440\u0443\u043F\u043E\u0432 \u043C\u043E\u0436\u0435\u0442 \u043D\u0430 \u0434\u043E\u043B\u044E \u0441\u0435\u043A\u0443\u043D\u0434\u044B \u043E\u0442\u0441\u0442\u0430\u0442\u044C \u0438\u0437-\u0437\u0430 Firebase, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u043E\u0436\u0438\u0432\u0448\u0438\u0439
  // \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u0436 \u043D\u0435 \u0434\u043E\u043B\u0436\u0435\u043D \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0442\u044C \u0432\u0438\u0434\u0435\u0442\u044C \u0441\u043E\u0431\u0441\u0442\u0432\u0435\u043D\u043D\u044B\u0439 \u0441\u0442\u0430\u0440\u044B\u0439 \u043A\u0440\u0435\u0441\u0442.
  for (const [characterId, target] of [...merged.entries()]) {
    const runtime = runtimeStates.get(characterId);
    if (!runtime) continue;
    if (runtime.runId && currentRunId() && String(runtime.runId) !== currentRunId()) continue;
    const targetUpdatedAt = Number(target?.updatedAt || target?.runtimeUpdatedAt || 0);
    const runtimeUpdatedAt = Number(runtime?.runtimeUpdatedAt || 0);
    // \u041F\u043E\u0437\u0434\u043D\u0435\u0435 \u0441\u0442\u0430\u0440\u043E\u0435 runtime-\u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u043D\u0435 \u0434\u043E\u043B\u0436\u043D\u043E \u0441\u0442\u0438\u0440\u0430\u0442\u044C \u0431\u043E\u043B\u0435\u0435 \u0441\u0432\u0435\u0436\u0438\u0439 \u0442\u0440\u0443\u043F.
    if (targetUpdatedAt > 0 && runtimeUpdatedAt > 0 && runtimeUpdatedAt < targetUpdatedAt) continue;
    const runtimeState = String(runtime.bodyState || "alive").toLowerCase();
    if (runtime.bodyPresent === false || !["dead", "being_helped"].includes(runtimeState)) {
      merged.delete(characterId);
    }
  }

  return [...merged.values()].filter(target => {
    const state = String(target?.bodyState || "").toLowerCase();
    return target?.bodyPresent !== false && ["dead", "being_helped"].includes(state);
  });
}

function getCorpseAt(mapX, mapY) {
  const x = clamp01(mapX);
  const y = clamp01(mapY);
  const viewport = document.getElementById("dpGameMapViewport");
  const rect = viewport?.getBoundingClientRect?.();
  const HIT_X = Math.max(0.055, rect?.width > 0 ? 34 / rect.width : 0.055);
  const HIT_Y = Math.max(0.075, rect?.height > 0 ? 38 / rect.height : 0.075);
  let best = null;
  let bestDistance = Infinity;
  for (const target of getVisibleHelpTargets()) {
    const tx = Number(target?.mapX);
    const ty = Number(target?.mapY);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
    const dx = Math.abs(x - tx);
    const dy = Math.abs(y - ty);
    if (dx > HIT_X || dy > HIT_Y) continue;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = {
        type: "corpse",
        id: `corpse:${String(target.characterId || "")}`,
        characterId: String(target.characterId || ""),
        name: String(target.displayName || target.characterId || "\u0442\u0440\u0443\u043F")
      };
    }
  }
  return best;
}

function getBlockedMapObjectAt(mapX, mapY) {
  const x = clamp01(mapX);
  const y = clamp01(mapY);
  const WALL_PAD = 0.012;
  if (x <= WALL_PAD || x >= 1 - WALL_PAD || y <= WALL_PAD || y >= 1 - WALL_PAD) {
    return { type: "wall" };
  }

  const corpse = getCorpseAt(x, y);
  if (corpse) return corpse;

  const PAD = 0.012;
  for (const object of getMapObjects()) {
    const ox = Number(object?.x ?? 0.5);
    const oy = Number(object?.y ?? 0.5);
    const ow = Math.max(0, Number(object?.w ?? 0.08));
    const oh = Math.max(0, Number(object?.h ?? 0.06));
    const left = ox - ow / 2 - PAD;
    const right = ox + ow / 2 + PAD;
    const top = oy - oh / 2 - PAD;
    const bottom = oy + oh / 2 + PAD;
    if (x >= left && x <= right && y >= top && y <= bottom) {
      return object || { type: "object" };
    }
  }
  return null;
}

function isBlockedMapPoint(mapX, mapY) {
  return !!getBlockedMapObjectAt(mapX, mapY);
}

function scheduleMapRender() {
  if (mapRenderQueued) return;
  mapRenderQueued = true;
  requestAnimationFrame(() => {
    mapRenderQueued = false;
    renderMap();
  });
}

function ensureMapUi() {
  const panel = document.getElementById("dpGameMapPanel");
  const viewport = document.getElementById("dpGameMapViewport");
  const floor = document.getElementById("dpGameMapFloor");
  if (!panel || !viewport || !floor) return null;

  let deathOverlay = document.getElementById("dpMapDeathOverlay");
  if (!deathOverlay) {
    deathOverlay = document.createElement("div");
    deathOverlay.id = "dpMapDeathOverlay";
    deathOverlay.setAttribute("aria-label", "\u041C\u0451\u0440\u0442\u0432");
    deathOverlay.innerHTML = `
      <div class="dp-map-dead-word">\u041C\u0401\u0420\u0422\u0412</div>
      <div class="dp-map-dead-note">\u041A\u0430\u0440\u0442\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430, \u043F\u043E\u043A\u0430 \u0442\u0435\u0431\u0435 \u043D\u0435 \u043F\u043E\u043C\u043E\u0433\u0443\u0442</div>`;
    viewport.appendChild(deathOverlay);
  }

  if (!mapClickBound) {
    mapClickBound = true;

    const syncCursor = event => {
      if (!viewport) return;
      if (!canCurrentViewerUseMap()) {
        viewport.style.cursor = "default";
        return;
      }
      if (event.target?.closest?.(".dp-map-corpse")) {
        viewport.style.cursor = "pointer";
        return;
      }
      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const mapX = clamp01((event.clientX - rect.left) / rect.width);
      const mapY = clamp01((event.clientY - rect.top) / rect.height);
      const object = getBlockedMapObjectAt(mapX, mapY);
      viewport.style.cursor = ["seat", "corpse"].includes(String(object?.type || ""))
        ? "pointer"
        : (object ? "default" : "crosshair");
    };

    viewport.addEventListener("pointermove", syncCursor);
    viewport.addEventListener("pointerenter", syncCursor);
    viewport.addEventListener("pointerleave", () => {
      viewport.style.cursor = canCurrentViewerUseMap() ? "crosshair" : "default";
    });

    // \u041A\u0430\u0440\u0442\u0430 \u043B\u0435\u0436\u0438\u0442 \u043F\u043E\u0432\u0435\u0440\u0445 \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u0433\u043E canvas \u0441\u0430\u0439\u0442\u0430. \u0413\u0430\u0441\u0438\u043C \u0441\u043E\u0431\u044B\u0442\u0438\u0435 \u0432\u0441\u0435\u0433\u0434\u0430,
    // \u0434\u0430\u0436\u0435 \u043A\u043E\u0433\u0434\u0430 \u043A\u0430\u0440\u0442\u0430 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u0442\u043E\u043B\u044C\u043A\u043E \u0434\u043B\u044F \u0447\u0442\u0435\u043D\u0438\u044F, \u0447\u0442\u043E\u0431\u044B \u043A\u043B\u0438\u043A \u043D\u0435 \u0441\u0442\u0430\u0432\u0438\u043B
    // \u043F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u044B\u0439 2D-\u0433\u043E\u043B\u043E\u0441 \u043F\u043E\u0434 \u043E\u043A\u043D\u043E\u043C \u043A\u0430\u0440\u0442\u044B.
    viewport.addEventListener("pointerdown", event => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (!canCurrentViewerUseMap()) return;

      const corpseElement = event.target?.closest?.(".dp-map-corpse");
      if (corpseElement) {
        const targetId = String(corpseElement.dataset.targetId || "");
        const corpseX = clamp01(Number(corpseElement.dataset.mapX ?? 0.5));
        const corpseY = clamp01(Number(corpseElement.dataset.mapY ?? 0.5));
        if (targetId) {
          viewport.style.cursor = "pointer";
          void submitMapPoint(corpseX, corpseY, "walk", false, targetId);
        }
        return;
      }

      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const mapX = clamp01((event.clientX - rect.left) / rect.width);
      const mapY = clamp01((event.clientY - rect.top) / rect.height);
      const object = getBlockedMapObjectAt(mapX, mapY);
      if (["seat", "corpse"].includes(String(object?.type || "")) && object?.id) {
        viewport.style.cursor = "pointer";
        void submitMapPoint(mapX, mapY, "walk", false, String(object.id));
        return;
      }
      if (object) {
        viewport.style.cursor = "default";
        return;
      }
      void submitMapPoint(mapX, mapY, event.shiftKey ? "run" : "walk", false, null);
    });

    for (const eventName of ["pointerup", "click", "dblclick", "contextmenu", "touchstart"]) {
      viewport.addEventListener(eventName, event => {
        event.stopPropagation();
      });
    }
  }

  return { panel, viewport, floor, deathOverlay };
}

async function submitMapPoint(mapX, mapY, moveMode = "walk", forceAdmissionSpawn = false, targetId = null) {
  if (IS_GAME_CONTROLLER || !auth?.currentUser || !state?.authed) return;
  if (!forceAdmissionSpawn && !canCurrentViewerUseMap()) return;

  const uid = window.__ccCanonicalUid?.() || auth.currentUser.uid;
  const rawName = state?.name || window.ccStorage?.getItem?.("cc_name") || "\u0427\u0443\u0436\u043E\u0439";
  const name = window.__ccCanonicalName?.(rawName) || rawName || "\u0427\u0443\u0436\u043E\u0439";
  const isHostSelf = Boolean(window.__ccIsHostName?.(name));
  const color = isHostSelf
    ? (window.HOST_IDENTITY?.color || "#1e40af")
    : String(state?.color || "#16c7b7");
  const emoji = isHostSelf
    ? (window.HOST_IDENTITY?.emoji || "")
    : String(state?.emoji || "");
  const screen = screenFromMapLocal(mapX, mapY);
  const previousPoint = bridgePoints.get(uid) || {};
  const now = Date.now();
  const userCommandAt = forceAdmissionSpawn
    ? Number(previousPoint.userCommandAt || previousPoint.requestedAt || now)
    : now;

  const point = {
    ...previousPoint,
    id: uid,
    name,
    color,
    emoji,
    x: screen.x,
    y: screen.y,
    mapX: clamp01(mapX),
    mapY: clamp01(mapY),
    targetId: targetId ? String(targetId) : null,
    moveMode,
    userCommandAt,
    requestedAt: now,
    ts: now,
    lastActive: now,
    runId: currentRunId(),
    runStartedAt: currentRunStartedAt()
  };

  bridgePoints.set(uid, point);
  scheduleMapRender();
  scheduleSnapshotToGame();
  try { window.__ccMarkActive?.(true); } catch {}

  try {
    await set(ref(db, `${GAME_POINTS_PATH}/${uid}`), point);
  } catch (error) {
    console.warn("[DP game] map point write failed", error);
  }
}

function wakeMapAfterGameStart() {
  // \u041F\u043E\u0441\u043B\u0435 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F \u0438\u0433\u0440\u044B \u043E\u043A\u043D\u043E \u043A\u0430\u0440\u0442\u044B \u0441\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F. \u041D\u0435\u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u044B \u043D\u0435 \u0443\u0441\u043F\u0435\u0432\u0430\u043B\u0438
  // \u043F\u0435\u0440\u0435\u0440\u0438\u0441\u043E\u0432\u0430\u0442\u044C \u0443\u0436\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u044E\u0449\u0443\u044E \u043F\u0430\u043D\u0435\u043B\u044C \u043F\u0440\u0438 \u043D\u043E\u0432\u043E\u043C runId, \u0445\u043E\u0442\u044F active=true
  // \u0434\u0430\u0432\u043D\u043E \u043F\u0440\u0438\u0448\u0451\u043B. \u041D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0434\u0435\u0448\u0451\u0432\u044B\u0445 \u043F\u043E\u0432\u0442\u043E\u0440\u043E\u0432 \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u044E\u0442 \u0435\u0451 \u0431\u0435\u0437 Ctrl+F5.
  renderMap();
  requestAnimationFrame(() => {
    renderMap();
    window.__dpMapWindow?.clamp?.();
  });
  setTimeout(() => renderMap(), 120);
  setTimeout(() => renderMap(), 650);
}


function renderMap() {
  const ui = ensureMapUi();
  if (!ui) return;

  if (!canCurrentViewerSeeMap()) {
    window.__dpMapWindow?.show?.(false);
    ui.panel.classList.remove("dp-map-visible");
    ui.panel.setAttribute("aria-hidden", "true");
    ui.viewport.style.cursor = "default";
    ui.viewport.classList.remove("dp-map-readonly", "dp-viewer-dead");
    ui.deathOverlay.classList.remove("show");
    ui.floor.classList.remove("dp-map-dead");
    ui.floor.innerHTML = "";
    return;
  }

  const entry = currentViewerEntry();
  const runtime = runtimeFromEntry(entry);
  const viewerDead = isDeadBodyState(runtime.bodyState);
  if (viewerDead) {
    window.__dpMapWindow?.setAspect?.(1.23);
    window.__dpMapWindow?.show?.(true);
    ui.panel.classList.add("dp-map-visible");
    ui.panel.setAttribute("aria-hidden", "false");
    ui.viewport.classList.add("dp-map-readonly", "dp-viewer-dead");
    ui.viewport.style.cursor = "default";
    ui.floor.classList.add("dp-map-dead");
    ui.floor.innerHTML = "";
    ui.deathOverlay.classList.add("show");
    return;
  }
  ui.deathOverlay.classList.remove("show");
  ui.viewport.classList.remove("dp-viewer-dead");
  ui.floor.classList.remove("dp-map-dead");

  const map = gamePublic.map || {};
  const capture = gamePublic.mapCapture || {};
  const captureMatchesScene = !capture.sceneId || !gamePublic.sceneId || capture.sceneId === gamePublic.sceneId;
  const hasCapture = (
    captureMatchesScene &&
    typeof capture.baseImage === "string" && capture.baseImage.startsWith("data:image/") &&
    typeof capture.maskImage === "string" && capture.maskImage.startsWith("data:image/")
  );
  const aspect = Math.max(.25, Math.min(4, Number(capture.aspect || map.aspect || 1)));
  const objects = Array.isArray(map.objects) ? map.objects : [];
  const allPlayers = allParticipants();
  const corpses = getVisibleHelpTargets();
  const corpseIds = new Set(corpses.map(corpse => String(corpse?.characterId || corpse?.uid || "")));
  const players = allPlayers.filter(player => !corpseIds.has(String(player?.uid || "")));
  const entities = [...gameEntities.values()];
  const viewer = currentViewerIdentity();
  const viewerColor = String(viewer.color || "#ffffff");
  const ownPoint = allPlayers.find(player => String(player.uid || "") === String(viewer.uid || ""));

  window.__dpMapWindow?.setAspect?.(aspect);
  window.__dpMapWindow?.show?.(true);
  ui.panel.classList.add("dp-map-visible");
  ui.panel.setAttribute("aria-hidden", "false");
  const mapInteractive = canCurrentViewerUseMap();
  ui.viewport.classList.toggle("dp-map-readonly", !mapInteractive);
  ui.viewport.style.cursor = mapInteractive ? "crosshair" : "default";
  ui.viewport.style.setProperty("--dp-map-aspect", String(aspect));
  ui.floor.style.setProperty("--dp-map-floor", String(map.floor || "#28303b"));
  ui.floor.style.setProperty("--dp-map-user-color", viewerColor);

  ui.floor.innerHTML = `
    ${hasCapture ? `
      <img class="dp-map-capture-base" alt="" draggable="false">
      <div class="dp-map-capture-tint"></div>
      <div class="dp-map-capture-glow"></div>
    ` : ""}
    ${hasCapture ? "" : `<div class="dp-map-loading">\u041A\u0430\u0440\u0442\u0430 \u0437\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u0442\u0441\u044F</div>`}
    ${mapInteractive && ownPoint ? `
      <div
        class="dp-map-target"
        title="\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0446\u0435\u043B\u044C"
        style="
          left:${Number(ownPoint.mapX ?? .5) * 100}%;
          top:${Number(ownPoint.mapY ?? .5) * 100}%;
          --tc:${escapeHtml(viewerColor)};
        ">
      </div>
    ` : ""}
    ${corpses.map(corpse => `
      <div
        class="dp-map-corpse"
        title="\u041F\u043E\u043C\u043E\u0447\u044C: ${escapeHtml(corpse.displayName || corpse.characterId || "\u0442\u0440\u0443\u043F")}"
        data-target-id="corpse:${escapeHtml(String(corpse.characterId || ""))}"
        data-map-x="${Number(corpse.mapX ?? .5)}"
        data-map-y="${Number(corpse.mapY ?? .5)}"
        style="
          left:${Number(corpse.mapX ?? .5) * 100}%;
          top:${Number(corpse.mapY ?? .5) * 100}%;
          --cc:${escapeHtml(corpse.color || "#ffffff")};
        ">\u271D</div>
    `).join("")}
    ${players.map(player => `
      <div
        class="dp-map-player${player.online ? "" : " offline"}"
        title="${escapeHtml(player.name || "\u0427\u0443\u0436\u043E\u0439")}"
        style="
          left:${Number(player.mapX ?? .5) * 100}%;
          top:${Number(player.mapY ?? .5) * 100}%;
          --pc:${escapeHtml(player.color || "#ffffff")};
        ">
      </div>
    `).join("")}
    ${entities.map(entity => `
      <div
        class="dp-map-entity"
        title="${escapeHtml(entity.name || "")}"
        style="
          left:${Number(entity.mapX ?? .5) * 100}%;
          top:${Number(entity.mapY ?? .5) * 100}%;
          color:${escapeHtml(entity.color || "#ffffff")};
        ">
        ${escapeHtml(entity.emoji || "\u25C9")}
      </div>
    `).join("")}
  `;

  if (hasCapture) {
    const baseLayer = ui.floor.querySelector(".dp-map-capture-base");
    const tintLayer = ui.floor.querySelector(".dp-map-capture-tint");
    const glowLayer = ui.floor.querySelector(".dp-map-capture-glow");
    if (baseLayer) baseLayer.src = capture.baseImage;
    const maskCss = `url("${capture.maskImage}")`;
    for (const layer of [tintLayer, glowLayer]) {
      if (!layer) continue;
      layer.style.webkitMaskImage = maskCss;
      layer.style.maskImage = maskCss;
    }
  }
}

// \u0412\u043E \u0432\u0440\u0435\u043C\u044F \u0438\u0433\u0440\u044B \u043A\u0430\u0440\u0442\u0430 \u043A\u043B\u0438\u043A\u0430\u0431\u0435\u043B\u044C\u043D\u0430 \u0438 \u043A\u0430\u043A \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E\u0435 \u043E\u043A\u043D\u043E, \u0438 \u0447\u0435\u0440\u0435\u0437 \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 canvas \u0441\u0430\u0439\u0442\u0430.
// \u041A\u043B\u0438\u043A \u043F\u043E canvas \u043F\u0435\u0440\u0435\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0432 \u043A\u043E\u043E\u0440\u0434\u0438\u043D\u0430\u0442\u044B \u043A\u043E\u043C\u043D\u0430\u0442\u044B. \u0415\u0441\u043B\u0438 \u044E\u0437\u0435\u0440 \u0442\u043A\u043D\u0443\u043B \u0432 \u043C\u0435\u0431\u0435\u043B\u044C/\u0441\u0442\u0435\u043D\u0443,
// \u0433\u043E\u043B\u043E\u0441 \u043D\u0435 \u0441\u0442\u0430\u0432\u0438\u0442\u0441\u044F.
window.__dpTransformVote = function transformVote(rawPoint) {
  return {
    x: Number(rawPoint?.x ?? 0.5),
    y: Number(rawPoint?.y ?? 0.5)
  };
};

// \u0421\u043E\u0432\u043C\u0435\u0441\u0442\u0438\u043C\u043E\u0441\u0442\u044C \u0441\u043E \u0441\u0442\u0430\u0440\u044B\u043C \u043F\u0440\u043E\u043F\u0430\u0442\u0447\u0435\u043D\u043D\u044B\u043C index.html.
window.__dpApplyGameMagnet = window.__dpTransformVote;

// \u041E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 canvas \u0441\u0430\u0439\u0442\u0430 \u043E\u0441\u0442\u0430\u0451\u0442\u0441\u044F \u0436\u0438\u0432\u044B\u043C \u0438 \u0442\u043E\u0436\u0435 \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u0433\u043E\u043B\u043E\u0441\u0430.
window.__dpShouldRenderPoint = function shouldRenderPoint() {
  // points снова содержат только голоса сайта. Координаты 3D-персонажей
  // лежат отдельно в game_v1/game_points.
  return true;
};

window.__dpForceShowPoints = function forceShowPoints() {
  return false;
};

function renderGameMessage(key, raw, announce = false) {
  const m = toDisplayMessage({ key, ...(raw || {}) });
  for (const listId of ["chatListSite", "chatListOverlay"]) {
    const list = document.getElementById(listId);
    if (!list) continue;
    const selector = `[data-game-msg-key="${CSS.escape(key)}"]`;
    let el = list.querySelector(selector);
    if (!el) {
      el = document.createElement("div");
      el.className = "chat-msg";
      el.dataset.gameMsgKey = key;
      list.appendChild(el);
    }
    el.innerHTML = `<div class="chat-msg-header"><b style="color:${escapeHtml(m.color)}">${escapeHtml(m.name)}</b></div><div class="chat-msg-text">${escapeHtml(m.text)}</div>`;
  }
  if (announce) showGameToast(m);
}

function removeGameMessage(key) {
  document.querySelectorAll(`[data-game-msg-key="${CSS.escape(key)}"]`).forEach(el => el.remove());
}

function scheduleSnapshotToGame() {
  if (snapshotSendQueued) return;
  snapshotSendQueued = true;
  queueMicrotask(() => {
    snapshotSendQueued = false;
    postSnapshotToGame();
  });
}

function bindFirebase() {
  const publicRef = ref(db, `${BASE_PATH}/public`);
  const messagesRef = ref(db, `${BASE_PATH}/messages`);
  const entitiesRef = ref(db, `${BASE_PATH}/entities`);
  const entranceRef = ref(db, ENTRANCE_PATH);
  const pointsRef = ref(db, GAME_POINTS_PATH);

  bridgePointsBound = true;
  const upsertBridgePoint = snap => {
    const value = snap.val() || {};
    if (!rowMatchesCurrentRun(value)) {
      bridgePoints.delete(snap.key);
      return;
    }
    const current = bridgePoints.get(snap.key) || {};
    const incomingStamp = Math.max(Number(value.requestedAt || 0), Number(value.lastActive || 0), Number(value.ts || 0));
    const currentStamp = Math.max(Number(current.requestedAt || 0), Number(current.lastActive || 0), Number(current.ts || 0));
    if (currentStamp > incomingStamp) return;
    bridgePoints.set(snap.key, value);
    scheduleMapRender();
    scheduleSnapshotToGame();
  };
  onChildAdded(pointsRef, upsertBridgePoint);
  onChildChanged(pointsRef, upsertBridgePoint);
  onChildRemoved(pointsRef, snap => {
    bridgePoints.delete(snap.key);
    scheduleMapRender();
    scheduleSnapshotToGame();
  });

  const applyPublicState = incomingValue => {
    const fastBridgeAlive = (
      lastLocalControllerPulseAt > 0 &&
      Date.now() - lastLocalControllerPulseAt <= LOCAL_STATE_STALE_MS
    );
    let rawIncoming = incomingValue || { active: false, inputMode: "map" };
    // A null/partial public snapshot must not hide a map while the dedicated
    // bridge lease (or same-origin BroadcastChannel) proves the game is alive.
    if (fastBridgeAlive && !rawIncoming.active) {
      rawIncoming = {
        ...(gamePublic || {}),
        ...(rawIncoming || {}),
        active: true,
        inputMode: String(rawIncoming?.inputMode || gamePublic?.inputMode || "map"),
        bridgeConnected: true,
        bridgeHeartbeatAt: Date.now()
      };
    }
    const heartbeatAt = Number(
      rawIncoming.bridgeHeartbeatAt || rawIncoming.updatedAt || rawIncoming.runStartedAt || 0
    );
    const heartbeatStale = Boolean(
      rawIncoming.active && !fastBridgeAlive && heartbeatAt > 0 &&
      Date.now() - heartbeatAt > GAME_HEARTBEAT_STALE_MS
    );
    const incoming = heartbeatStale
      ? { ...rawIncoming, active: false, bridgeStale: true }
      : rawIncoming;
    const incomingRunId = String(incoming.runId || "");
    const incomingStartedAt = Number(incoming.runStartedAt || 0);
    const incomingRevision = Number(incoming.stateRevision || 0);
    const wasActive = Boolean(gamePublic?.active);
    const previousRunId = currentRunId();

    if (IS_GAME_CONTROLLER && activeRunId && incomingRunId !== activeRunId) return;
    if (incomingRunId && !activateRun(incomingRunId, incomingStartedAt)) return;

    if (IS_GAME_CONTROLLER && incomingRunId === activeRunId && incomingRevision < activeStateRevision) {
      gamePublic = {
        ...incoming,
        ...(gamePublic || {}),
        map: incoming.map || gamePublic?.map || {},
        mapCapture: incoming.mapCapture || gamePublic?.mapCapture || null
      };
    } else {
      gamePublic = incoming;
      activeStateRevision = Math.max(activeStateRevision, incomingRevision);
    }

    renderAdmissionUi();
    renderMap();
    scheduleSnapshotToGame();

    const runChanged = Boolean(incomingRunId && incomingRunId !== previousRunId);
    if ((!wasActive && gamePublic?.active) || (runChanged && gamePublic?.active)) {
      wakeMapAfterGameStart();
    }
  };

  applyPublicStateSnapshot = applyPublicState;
  if (pendingLocalPublicState) {
    const pending = pendingLocalPublicState;
    pendingLocalPublicState = null;
    applyPublicState(pending);
  }

  onValue(publicRef, snap => applyPublicState(snap.val()));

  if (!traitorVoteListenerBound) {
    traitorVoteListenerBound = true;
    onValue(ref(db, TRAITOR_VOTE_PATH), snap => {
      const value = snap.val();
      traitorVoteState = value && typeof value === "object" ? value : {};
      renderTraitorVote();
      scheduleSnapshotToGame();
    });
  }

  // A tiny dedicated controller lease. Unlike the large public object it is
  // rewritten atomically every second, so a late map-capture/public update
  // cannot accidentally make the ordinary site think the game is gone.
  const bridgeLiveRef = ref(db, BRIDGE_LIVE_PATH);
  onValue(bridgeLiveRef, snap => {
    if (IS_GAME_CONTROLLER) return;
    const live = snap.val() || {};
    const heartbeatAt = Number(live.bridgeHeartbeatAt || 0);
    const fresh = Boolean(
      live.active && heartbeatAt > 0 && Date.now() - heartbeatAt <= LOCAL_STATE_STALE_MS
    );
    if (fresh) {
      lastLocalControllerPulseAt = Date.now();
      applyPublicState({ ...(gamePublic || {}), ...live, active: true });
      return;
    }
    if (heartbeatAt > 0 && live.active === false) {
      lastLocalControllerPulseAt = 0;
      applyPublicState({ ...(gamePublic || {}), ...live, active: false });
      return;
    }
    if (heartbeatAt > 0 && Date.now() - heartbeatAt > LOCAL_STATE_STALE_MS) {
      lastLocalControllerPulseAt = 0;
      renderAdmissionUi();
      renderMap();
    }
  });

  // \u0422\u0440\u0443\u043F\u044B \u0441\u043B\u0443\u0448\u0430\u0435\u043C \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u044B\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u0438\u043C \u043A\u0430\u043D\u0430\u043B\u043E\u043C. \u0411\u043E\u043B\u044C\u0448\u043E\u0439 public/mapCapture \u043C\u043E\u0436\u0435\u0442
  // \u043F\u0440\u0438\u0445\u043E\u0434\u0438\u0442\u044C \u043F\u043E\u0437\u0436\u0435 \u0438\u043B\u0438 \u0431\u044B\u0442\u044C \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u0437\u0430\u043A\u0435\u0448\u0438\u0440\u043E\u0432\u0430\u043D \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u043E\u043C, \u043D\u043E \u043A\u0440\u0435\u0441\u0442\u044B \u0438 \u043F\u043E\u043C\u043E\u0449\u044C
  // \u0434\u043E\u043B\u0436\u043D\u044B \u043E\u0431\u043D\u043E\u0432\u043B\u044F\u0442\u044C\u0441\u044F \u043D\u0435\u043C\u0435\u0434\u043B\u0435\u043D\u043D\u043E.
  if (!helpTargetsListenerBound) {
    helpTargetsListenerBound = true;
    const dedicatedHelpTargetsRef = ref(db, `${BASE_PATH}/public/helpTargets`);
    onValue(dedicatedHelpTargetsRef, snap => {
      replaceHelpTargetsFromValue(snap.val());
    });
  }

  // \u041B\u0451\u0445\u0430 \u0436\u0438\u0432\u0451\u0442 \u0432 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E\u043C \u043A\u0430\u043D\u0430\u043B\u0435: \u0443 \u043D\u0435\u0433\u043E \u043D\u0435\u0442 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u0441\u043A\u043E\u0439 Firebase-\u0442\u043E\u0447\u043A\u0438,
  // \u0430 \u043E\u0431\u0449\u0438\u0439 public/helpTargets \u043C\u043E\u0436\u0435\u0442 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0438\u0441\u044B\u0432\u0430\u0442\u044C\u0441\u044F \u043F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u044B\u043C\u0438 \u0432\u043A\u043B\u0430\u0434\u043A\u0430\u043C\u0438.
  if (!hostCorpseListenerBound) {
    hostCorpseListenerBound = true;
    const dedicatedHostCorpseRef = ref(db, `${BASE_PATH}/public/hostCorpse`);
    onValue(dedicatedHostCorpseRef, snap => {
      const value = snap.val();
      hostCorpseState = value && typeof value === "object" ? value : null;
      renderMap();
    });
  }

  // onValue \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u043D\u0430\u0434\u0451\u0436\u0435\u043D \u0441\u0430\u043C \u043F\u043E \u0441\u0435\u0431\u0435, \u043D\u043E \u043F\u043E\u0441\u043B\u0435 \u0431\u044B\u0441\u0442\u0440\u043E\u0433\u043E
  // \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F/\u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0438\u0433\u0440\u044B \u0432\u043A\u043B\u0430\u0434\u043A\u0430 \u0438\u043D\u043E\u0433\u0434\u0430 \u043E\u0441\u0442\u0430\u0432\u0430\u043B\u0430\u0441\u044C \u0441 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u043C active=false.
  // \u0420\u0435\u0434\u043A\u0438\u0439 \u043A\u043E\u043D\u0442\u0440\u043E\u043B\u044C\u043D\u044B\u0439 get \u0447\u0438\u043D\u0438\u0442 \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043D\u043E\u0435 \u0441\u043E\u0431\u044B\u0442\u0438\u0435 \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0441\u0430\u0439\u0442\u0430.
  if (!publicRecoveryStarted) {
    publicRecoveryStarted = true;
    setInterval(async () => {
      try {
        const snapshot = await get(publicRef);
        applyPublicState(snapshot.val());
      } catch (error) {
        console.warn("[DP game] public state recovery failed", error);
      }
    }, 1200);
  }

  const upsertEntrance = snap => {
    const value = { uid: snap.key, ...(snap.val() || {}) };
    if (!rowMatchesCurrentRun(value)) {
      entranceRequests.delete(snap.key);
      return;
    }
    const tombstoneAt = Number(completedExitTombstones.get(snap.key) || 0);
    const incomingStatus = String(value.status || "");
    if (tombstoneAt > 0 && !["outside", "approaching"].includes(incomingStatus)) {
      return;
    }
    if (incomingStatus === "approaching") completedExitTombstones.delete(snap.key);
    const current = entranceRequests.get(snap.key) || {};
    if (Number(current.updatedAt || 0) > Number(value.updatedAt || 0)) return;
    entranceRequests.set(snap.key, value);
    renderAdmissionUi();
    renderMap();
    scheduleSnapshotToGame();
  };
  onChildAdded(entranceRef, upsertEntrance);
  onChildChanged(entranceRef, upsertEntrance);
  onChildRemoved(entranceRef, snap => {
    entranceRequests.delete(snap.key);
    renderAdmissionUi();
    renderMap();
    scheduleSnapshotToGame();
  });

  onChildAdded(messagesRef, snap => {
    const value = snap.val() || {};
    gameMessages.set(snap.key, value);
    const shouldAnnounce = Number(value.createdAt || value.t || 0) >= initAt - 1000;
    renderGameMessage(snap.key, value, shouldAnnounce);
    scheduleSnapshotToGame();
  });
  onChildChanged(messagesRef, snap => {
    const value = snap.val() || {};
    gameMessages.set(snap.key, value);
    renderGameMessage(snap.key, value, false);
    scheduleSnapshotToGame();
  });
  onChildRemoved(messagesRef, snap => {
    gameMessages.delete(snap.key);
    removeGameMessage(snap.key);
    scheduleSnapshotToGame();
  });

  onChildAdded(entitiesRef, snap => {
    gameEntities.set(snap.key, { id: snap.key, ...(snap.val() || {}) });
    renderMap();
    scheduleSnapshotToGame();
  });
  onChildChanged(entitiesRef, snap => {
    gameEntities.set(snap.key, { id: snap.key, ...(snap.val() || {}) });
    renderMap();
    scheduleSnapshotToGame();
  });
  onChildRemoved(entitiesRef, snap => {
    gameEntities.delete(snap.key);
    renderMap();
    scheduleSnapshotToGame();
  });
}

function bindPrivateEvents() {
  renderTraitorVote();
  const uid = window.__ccCanonicalUid?.() || auth?.currentUser?.uid;
  if (!uid || uid === privateBoundUid) return;
  privateBoundUid = uid;
  const privateRef = ref(db, `${BASE_PATH}/private/${uid}`);
  onChildAdded(privateRef, snap => {
    const value = snap.val() || {};
    if (Number(value.createdAt || 0) < initAt - 1000) return;
    showPrivateEvent({ key: snap.key, ...value });
    setTimeout(() => remove(ref(db, `${BASE_PATH}/private/${uid}/${snap.key}`)).catch(() => {}), 1000);
  });
}

function monitorRealChatForHost() {
  setInterval(() => {
    bindPrivateEvents();
    if (!IS_GAME_HOST) return;
    const rows = getRealChat();
    const last = rows.at(-1);
    if (!last) return;
    const key = String(last.key || `${last.t || last.ts}:${last.uid || ""}:${last.text || ""}`);
    if (!lastRealChatKey) {
      lastRealChatKey = key;
      return;
    }
    if (key === lastRealChatKey) return;
    lastRealChatKey = key;
    showGameToast(last);
  }, 500);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function serializedHelpTargets() {
  return [...helpTargets.values()].map(target => ({ ...(target || {}) }));
}

function replaceHelpTargetsFromValue(rawValue) {
  helpTargets.clear();
  const rows = Array.isArray(rawValue)
    ? rawValue
    : Object.values(rawValue || {});
  for (const rawTarget of rows) {
    const target = rawTarget || {};
    const characterId = String(target.characterId || target.uid || "");
    if (!characterId) continue;
    if (target.runId && currentRunId() && String(target.runId) !== currentRunId()) continue;
    const bodyState = String(target.bodyState || "").toLowerCase();
    if (target.bodyPresent === false || !["dead", "being_helped"].includes(bodyState)) continue;
    helpTargets.set(characterId, { ...target, characterId });
  }
  gamePublic = { ...(gamePublic || {}), helpTargets: serializedHelpTargets() };
  renderMap();
}

function serializedHelpTargetsById() {
  const result = {};
  for (const target of helpTargets.values()) {
    const characterId = String(target?.characterId || target?.uid || "");
    if (!characterId) continue;
    result[characterId] = {
      ...(target || {}),
      characterId,
      runId: String(target?.runId || currentRunId()),
      runStartedAt: Number(target?.runStartedAt || currentRunStartedAt())
    };
  }
  return result;
}

async function publishHelpTargetsNow() {
  const targets = serializedHelpTargets();
  const targetsById = serializedHelpTargetsById();
  gamePublic = { ...(gamePublic || {}), helpTargets: targets };
  renderMap();
  helpTargetsWriteChain = helpTargetsWriteChain
    .catch(() => {})
    .then(() => set(ref(db, `${BASE_PATH}/public/helpTargets`), targetsById))
    .catch(error => console.warn("[DP game] help targets write failed", error));
}

async function updateEntranceStatus(uid, status, payload = {}) {
  if (!uid) return;
  const current = entranceRequests.get(uid) || {};
  const timestampKey = ({
    approaching: "approachingAt",
    waiting: "arrivedAt",
    entering: "enteringAt",
    admitted: "admittedAt",
    leaving: "leavingAt",
    outside: "leftAt"
  })[status] || "updatedAt";
  const next = {
    ...current,
    ...payload,
    uid,
    status,
    runId: String(payload.runId || current.runId || currentRunId()),
    runStartedAt: Number(payload.runStartedAt || current.runStartedAt || currentRunStartedAt())
  };
  const statusChanged = String(current.status || "") !== String(status || "");
  if (statusChanged || !Number(current[timestampKey])) {
    next[timestampKey] = Date.now();
  } else {
    next[timestampKey] = current[timestampKey];
  }
  next.updatedAt = Date.now();

  entranceRequests.set(uid, next);
  renderAdmissionUi();
  renderMap();
  scheduleSnapshotToGame();
  queueEntranceWrite(uid, next);
  return next;
}


function cleanupMapCaptureAssemblies() {
  const now = Date.now();
  for (const [captureId, assembly] of mapCaptureAssemblies) {
    if (now - Number(assembly.createdAt || now) > 60000) {
      mapCaptureAssemblies.delete(captureId);
    }
  }
}

function beginMapCaptureAssembly(payload) {
  const captureId = String(payload.captureId || "");
  if (!captureId) return;
  cleanupMapCaptureAssemblies();

  const baseCount = Math.max(0, Number(payload.baseChunks || 0));
  const maskCount = Math.max(0, Number(payload.maskChunks || 0));
  console.log("[DP game] map capture begin", {
    captureId,
    baseChunks: baseCount,
    maskChunks: maskCount,
    baseLength: Number(payload.baseLength || 0),
    maskLength: Number(payload.maskLength || 0),
    round: Number(payload.round || 0)
  });
  const existing = mapCaptureAssemblies.get(captureId);
  if (existing && existing.base.length === baseCount && existing.mask.length === maskCount) {
    existing.createdAt = Date.now();
    existing.commitRequested = false;
    existing.objects = Array.isArray(payload.objects) ? payload.objects : existing.objects;
    return;
  }

  mapCaptureAssemblies.set(captureId, {
    captureId,
    sceneId: String(payload.sceneId || ""),
    version: Number(payload.version || 1),
    width: Number(payload.width || 0),
    height: Number(payload.height || 0),
    aspect: Math.max(.25, Math.min(4, Number(payload.aspect || 1))),
    furnitureCount: Number(payload.furnitureCount || 0),
    objects: Array.isArray(payload.objects) ? payload.objects : [],
    baseLength: Number(payload.baseLength || 0),
    maskLength: Number(payload.maskLength || 0),
    base: Array(baseCount).fill(null),
    mask: Array(maskCount).fill(null),
    commitRequested: false,
    writing: false,
    createdAt: Date.now()
  });
}

function addMapCaptureChunk(payload) {
  const captureId = String(payload.captureId || "");
  const assembly = mapCaptureAssemblies.get(captureId);
  if (!assembly) return;
  const part = payload.part === "mask" ? "mask" : "base";
  const index = Number(payload.index);
  if (!Number.isInteger(index) || index < 0 || index >= assembly[part].length) return;
  assembly[part][index] = String(payload.data || "");
  const received = assembly[part].reduce((count, item) => count + (typeof item === "string" ? 1 : 0), 0);
  if (index === 0 || index === assembly[part].length - 1) {
    console.log("[DP game] map capture chunk", {
      captureId,
      part,
      received,
      total: assembly[part].length
    });
  }
  void tryCommitMapCapture(captureId);
}

async function tryCommitMapCapture(captureId) {
  const assembly = mapCaptureAssemblies.get(String(captureId || ""));
  if (!assembly || !assembly.commitRequested || assembly.writing) return;
  if (!assembly.base.length || !assembly.mask.length) return;
  if (assembly.base.some(part => typeof part !== "string")) return;
  if (assembly.mask.some(part => typeof part !== "string")) return;

  const baseImage = assembly.base.join("");
  const maskImage = assembly.mask.join("");
  if (
    !baseImage.startsWith("data:image/") ||
    !maskImage.startsWith("data:image/") ||
    (assembly.baseLength && baseImage.length !== assembly.baseLength) ||
    (assembly.maskLength && maskImage.length !== assembly.maskLength)
  ) {
    console.warn("[DP game] map capture chunks are incomplete", {
      captureId,
      base: `${baseImage.length}/${assembly.baseLength}`,
      mask: `${maskImage.length}/${assembly.maskLength}`
    });
    return;
  }

  assembly.writing = true;
  const capturePath = `${BASE_PATH}/public/mapCapture`;
  try {
    console.log("[DP game] storing map base", { captureId: assembly.captureId, bytes: baseImage.length });
    await set(ref(db, `${capturePath}/baseImage`), baseImage);

    console.log("[DP game] storing map mask", { captureId: assembly.captureId, bytes: maskImage.length });
    await set(ref(db, `${capturePath}/maskImage`), maskImage);

    await update(ref(db, capturePath), {
      captureId: assembly.captureId,
      sceneId: assembly.sceneId,
      version: assembly.version,
      width: assembly.width,
      height: assembly.height,
      aspect: assembly.aspect,
      furnitureCount: assembly.furnitureCount,
      capturedAt: Date.now()
    });
    await update(ref(db, `${BASE_PATH}/public`), {
      map: {
        ...(gamePublic?.map || {}),
        aspect: assembly.aspect,
        objects: assembly.objects
      },
      updatedAt: serverTimestamp(),
      updatedBy: window.__ccCanonicalUid?.() || auth?.currentUser?.uid || "host"
    });
    console.log("[DP game] real map capture stored", {
      captureId: assembly.captureId,
      baseBytes: baseImage.length,
      maskBytes: maskImage.length
    });
    mapCaptureAssemblies.delete(assembly.captureId);
    scheduleSnapshotToGame();
  } catch (error) {
    assembly.writing = false;
    console.error("[DP game] map capture write failed", {
      captureId: assembly.captureId,
      code: error?.code || "",
      message: error?.message || String(error),
      error
    });
  }
}

async function receiveFromGame(event) {
  if (!IS_GAME_CONTROLLER || !event || typeof event !== "object") return;
  const type = String(event.type || "");
  const payload = event.payload || {};
  const meta = eventRunMeta(event);

  if (type === "reset_entrance" || type === "publish_state") {
    if (meta.runId && !activateRun(meta.runId, meta.runStartedAt)) return;
  } else if (!eventBelongsToActiveRun(event)) {
    return;
  }

  if (type === "publish_state") {
    const incomingRevision = Number(payload.stateRevision || 0);
    if (incomingRevision && incomingRevision < activeStateRevision) return;
    activeStateRevision = Math.max(activeStateRevision, incomingRevision);
    const bridgeHeartbeatAt = Date.now();
    const publicPayload = {
      ...(payload || {}),
      bridgeHeartbeatAt,
      bridgeConnected: true
    };
    gamePublic = { ...(gamePublic || {}), ...publicPayload };
    if (Object.prototype.hasOwnProperty.call(payload || {}, "helpTargets")) {
      helpTargets.clear();
      const incomingTargets = Array.isArray(payload.helpTargets)
        ? payload.helpTargets
        : Object.values(payload.helpTargets || {});
      for (const target of incomingTargets) {
        const characterId = String(target?.characterId || target?.uid || "");
        if (characterId) helpTargets.set(characterId, { ...(target || {}), characterId });
      }
    }
    renderAdmissionUi();
    renderMap();
    broadcastLocalState("public_state", publicPayload);
    void set(ref(db, BRIDGE_LIVE_PATH), localHeartbeatPayload(bridgeHeartbeatAt))
      .catch(error => console.warn("[DP game] bridge lease write failed", error));
    queuePublicPatch(publicPayload);
    return;
  }

  if (type === "map_capture_begin") {
    beginMapCaptureAssembly(payload);
    return;
  }

  if (type === "map_capture_chunk") {
    addMapCaptureChunk(payload);
    return;
  }

  if (type === "map_capture_commit") {
    const captureId = String(payload.captureId || "");
    const assembly = mapCaptureAssemblies.get(captureId);
    if (assembly) {
      assembly.commitRequested = true;
      void tryCommitMapCapture(captureId);
    }
    return;
  }

  if (type === "map_capture") {
    const capture = payload.capture || {};
    if (
      typeof capture.baseImage !== "string" || !capture.baseImage.startsWith("data:image/") ||
      typeof capture.maskImage !== "string" || !capture.maskImage.startsWith("data:image/")
    ) {
      console.warn("[DP game] map_capture without valid images");
      return;
    }

    const objects = Array.isArray(payload.objects) ? payload.objects : [];
    const aspect = Math.max(.25, Math.min(4, Number(payload.aspect || capture.aspect || 1)));
    await update(ref(db, `${BASE_PATH}/public`), {
      mapCapture: {
        ...capture,
        aspect,
        capturedAt: Date.now()
      },
      map: {
        ...(gamePublic?.map || {}),
        aspect,
        objects
      },
      updatedAt: serverTimestamp(),
      updatedBy: window.__ccCanonicalUid?.() || auth?.currentUser?.uid || "host"
    });
    return;
  }

  if (type === "reset_entrance") {
    entranceRequests.clear();
    completedExitTombstones.clear();
    helpTargets.clear();
    traitorVoteState = {};
    renderTraitorVote();
    hostCorpseState = null;
    runtimeStates.clear();
    admissionSpawnWritten.clear();
    bridgePoints.clear();
    gamePublic = {
      ...(gamePublic || {}),
      runId: meta.runId || currentRunId(),
      runStartedAt: meta.runStartedAt || currentRunStartedAt(),
      helpTargets: [],
      hostCorpse: null
    };
    renderAdmissionUi();
    renderMap();
    scheduleSnapshotToGame();
    // \u0421\u0442\u0430\u0440\u044B\u0435 \u0437\u0430\u043F\u0438\u0441\u0438 \u043D\u0435 \u0443\u0434\u0430\u043B\u044F\u0435\u043C \u0444\u0438\u0437\u0438\u0447\u0435\u0441\u043A\u0438: \u043E\u043D\u0438 \u043F\u043E\u043C\u0435\u0447\u0435\u043D\u044B \u043F\u0440\u043E\u0448\u043B\u044B\u043C runId \u0438
    // \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E \u0438\u0433\u043D\u043E\u0440\u0438\u0440\u0443\u044E\u0442\u0441\u044F. \u0422\u0430\u043A \u043D\u043E\u0432\u044B\u0439 \u0437\u0440\u0438\u0442\u0435\u043B\u044C \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u043F\u043E\u043F\u0430\u0441\u0442\u044C \u043F\u043E\u0434 \u043F\u043E\u0437\u0434\u043D\u0438\u0439
    // remove() \u0441\u0442\u0430\u0440\u043E\u0439 \u0441\u0435\u0441\u0441\u0438\u0438 \u0441\u0440\u0430\u0437\u0443 \u043F\u043E\u0441\u043B\u0435 \u043D\u0430\u0436\u0430\u0442\u0438\u044F \u00AB\u0412\u043E\u0439\u0442\u0438\u00BB.
    void update(ref(db, `${BASE_PATH}/public`), { helpTargets: {}, hostCorpse: null })
      .catch(error => console.warn("[DP game] reset help targets failed", error));
    void remove(ref(db, GAME_POINTS_PATH))
      .catch(error => console.warn("[DP game] reset game points failed", error));
    void remove(ref(db, TRAITOR_VOTE_PATH))
      .catch(error => console.warn("[DP game] reset traitor vote failed", error));
    return;
  }


  if (type === "traitor_vote_start") {
    traitorVoteState = {
      active: true,
      phase: "voting",
      runId: currentRunId(),
      runStartedAt: currentRunStartedAt(),
      title: String(payload.title || "Кто предатель?"),
      warning: String(
        payload.warning ||
        "Если вы правы, вы проживёте дольше. Если нет — выбранный Лёхой человек лишится одной руки помощи."
      ),
      candidates: Array.isArray(payload.candidates) ? payload.candidates : Object.values(payload.candidates || {}),
      eligibleVoterIds: Array.isArray(payload.eligibleVoterIds)
        ? payload.eligibleVoterIds
        : Object.values(payload.eligibleVoterIds || {}),
      startedAt: Number(payload.startedAt || Date.now()),
      votes: {}
    };
    await set(ref(db, TRAITOR_VOTE_PATH), traitorVoteState);
    renderTraitorVote();
    scheduleSnapshotToGame();
    return;
  }

  if (type === "traitor_vote_host_choice_ready") {
    traitorVoteState = {
      ...(traitorVoteState || {}),
      active: true,
      phase: "host_choice",
      receivedVotes: Number(payload.receivedVotes || 0),
      requiredVotes: Number(payload.requiredVotes || 0),
      hostChoiceReadyAt: Date.now()
    };
    await update(ref(db, TRAITOR_VOTE_PATH), {
      active: true,
      phase: "host_choice",
      receivedVotes: traitorVoteState.receivedVotes,
      requiredVotes: traitorVoteState.requiredVotes,
      hostChoiceReadyAt: traitorVoteState.hostChoiceReadyAt
    });
    renderTraitorVote();
    scheduleSnapshotToGame();
    return;
  }

  if (type === "traitor_vote_reveal") {
    traitorVoteState = {
      ...(traitorVoteState || {}),
      active: true,
      phase: "reveal",
      majorityRole: String(payload.majorityRole || ""),
      majorityName: String(payload.majorityName || "Никто"),
      hostChoiceRole: String(payload.hostChoiceRole || ""),
      hostChoiceName: String(payload.hostChoiceName || ""),
      counts: payload.counts || {},
      penaltyApplied: Boolean(payload.penaltyApplied),
      penaltyText: String(payload.penaltyText || ""),
      revealedAt: Date.now()
    };
    await update(ref(db, TRAITOR_VOTE_PATH), {
      active: true,
      phase: "reveal",
      majorityRole: traitorVoteState.majorityRole,
      majorityName: traitorVoteState.majorityName,
      hostChoiceRole: traitorVoteState.hostChoiceRole,
      hostChoiceName: traitorVoteState.hostChoiceName,
      counts: traitorVoteState.counts,
      penaltyApplied: traitorVoteState.penaltyApplied,
      penaltyText: traitorVoteState.penaltyText,
      revealedAt: traitorVoteState.revealedAt
    });
    renderTraitorVote();
    scheduleSnapshotToGame();
    return;
  }

  if (type === "traitor_vote_intro_finished") {
    traitorVoteState = {
      ...(traitorVoteState || {}),
      active: true,
      phase: "finished",
      finishedAt: Date.now(),
      victimId: String(payload.victimId || "")
    };
    await update(ref(db, TRAITOR_VOTE_PATH), {
      active: true,
      phase: "finished",
      finishedAt: traitorVoteState.finishedAt,
      victimId: traitorVoteState.victimId
    });
    renderTraitorVote();
    scheduleSnapshotToGame();
    return;
  }

  if (type === "traitor_vote_reset") {
    traitorVoteState = {};
    renderTraitorVote();
    await remove(ref(db, TRAITOR_VOTE_PATH)).catch(() => {});
    scheduleSnapshotToGame();
    return;
  }

  if (type === "help_target_state" || type === "host_corpse_state") {
    const characterId = String(payload.characterId || payload.uid || (type === "host_corpse_state" ? "leha" : ""));
    if (!characterId) return;
    const bodyState = String(payload.bodyState || "alive").toLowerCase();
    const bodyPresent = payload.bodyPresent !== false;
    const eventUpdatedAt = Date.now();
    const existingRuntime = runtimeStates.get(characterId) || {};
    runtimeStates.set(characterId, {
      ...existingRuntime,
      bodyState,
      bodyPresent,
      runtimeUpdatedAt: eventUpdatedAt,
      runId: currentRunId()
    });
    if (!bodyPresent || !["dead", "being_helped"].includes(bodyState)) {
      helpTargets.delete(characterId);
    } else {
      helpTargets.set(characterId, {
        characterId,
        displayName: String(payload.displayName || payload.display_name || characterId),
        bodyState,
        bodyPresent,
        color: String(payload.color || "#ffffff"),
        mapX: clamp01(payload.mapX ?? .5),
        mapY: clamp01(payload.mapY ?? .5),
        updatedAt: eventUpdatedAt,
        runId: currentRunId(),
        runStartedAt: currentRunStartedAt()
      });
    }
    if (characterId === "leha") {
      const hostCorpse = (!bodyPresent || !["dead", "being_helped"].includes(bodyState))
        ? null
        : { ...(helpTargets.get(characterId) || {}), characterId: "leha", updatedAt: eventUpdatedAt };
      hostCorpseState = hostCorpse;
      gamePublic = { ...(gamePublic || {}), hostCorpse };
      // \u041F\u0438\u0448\u0435\u043C \u0438\u043C\u0435\u043D\u043D\u043E \u0432 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u044B\u0439 \u043F\u0443\u0442\u044C. \u041F\u043E\u043B\u043D\u044B\u0435 public-\u043F\u0430\u0442\u0447\u0438 \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u043C\u043E\u0433\u0443\u0442
      // \u0441\u043B\u0443\u0447\u0430\u0439\u043D\u043E \u0437\u0430\u0442\u0435\u0440\u0435\u0442\u044C \u0442\u0440\u0443\u043F \u041B\u0451\u0445\u0438 \u0441\u0442\u0430\u0440\u044B\u043C \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435\u043C.
      void set(ref(db, `${BASE_PATH}/public/hostCorpse`), hostCorpse)
        .catch(error => console.warn("[DP game] host corpse write failed", error));
    }
    renderAdmissionUi();
    renderMap();
    await publishHelpTargetsNow();
    return;
  }

  if (type === "participant_runtime_state") {
    const uid = String(payload.uid || payload.characterId || "");
    if (!uid) return;
    const checkpointRestore = Boolean(payload.checkpointRestore);
    const existing = entranceRequests.get(uid) || {
      uid,
      name: String(payload.name || payload.displayName || uid),
      role: String(payload.role || "guest"),
      color: String(payload.color || "#cccccc"),
      emoji: String(payload.emoji || ""),
      status: String(payload.forceStatus || payload.status || "admitted"),
      requestedAt: Number(payload.requestedAt || Date.now()),
      runId: currentRunId(),
      runStartedAt: currentRunStartedAt()
    };
    const runtimeEventUpdatedAt = Date.now();
    const runtime = {
      bodyState: String(payload.bodyState || existing.bodyState || "alive"),
      controllerState: String(payload.controllerState || existing.controllerState || "attached"),
      exitRequested: Boolean(payload.exitRequested),
      bodyPresent: payload.bodyPresent !== false,
      deathReason: String(payload.deathReason || ""),
      runtimeUpdatedAt: runtimeEventUpdatedAt,
      runId: currentRunId()
    };
    runtimeStates.set(uid, runtime);

    // \u0420\u0435\u0437\u0435\u0440\u0432\u043D\u044B\u0439 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u0442\u0440\u0443\u043F\u043E\u0432: \u0434\u0430\u0436\u0435 \u0435\u0441\u043B\u0438 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E\u0435 help_target_state \u043F\u043E\u0442\u0435\u0440\u044F\u043B\u043E\u0441\u044C,
    // runtime \u0437\u0440\u0438\u0442\u0435\u043B\u044F \u0432\u0441\u0451 \u0440\u0430\u0432\u043D\u043E \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u0442 \u0441\u043C\u0435\u0440\u0442\u044C \u0438 \u043A\u043E\u043E\u0440\u0434\u0438\u043D\u0430\u0442\u044B.
    const runtimeMapX = Number(payload.mapX);
    const runtimeMapY = Number(payload.mapY);
    if (
      runtime.bodyPresent && ["dead", "being_helped"].includes(String(runtime.bodyState).toLowerCase()) &&
      Number.isFinite(runtimeMapX) && Number.isFinite(runtimeMapY)
    ) {
      helpTargets.set(uid, {
        characterId: uid,
        displayName: String(payload.name || payload.displayName || existing.name || uid),
        bodyState: String(runtime.bodyState).toLowerCase(),
        bodyPresent: true,
        color: String(payload.color || existing.color || "#ffffff"),
        mapX: clamp01(runtimeMapX),
        mapY: clamp01(runtimeMapY),
        runId: currentRunId(),
        runStartedAt: currentRunStartedAt()
      });
      void publishHelpTargetsNow();
    } else if (!["dying", "dead", "being_helped", "reviving"].includes(String(runtime.bodyState).toLowerCase())) {
      helpTargets.delete(uid);
      void publishHelpTargetsNow();
    }

    if (uid === "leha") {
      const hostCorpse = (
        runtime.bodyPresent &&
        ["dead", "being_helped"].includes(String(runtime.bodyState).toLowerCase()) &&
        Number.isFinite(runtimeMapX) && Number.isFinite(runtimeMapY)
      ) ? {
        characterId: "leha",
        displayName: "\u041B\u0451\u0445\u0430",
        bodyState: String(runtime.bodyState).toLowerCase(),
        bodyPresent: true,
        color: String(payload.color || "#1e40af"),
        mapX: clamp01(runtimeMapX),
        mapY: clamp01(runtimeMapY),
        updatedAt: runtimeEventUpdatedAt,
        runId: currentRunId(),
        runStartedAt: currentRunStartedAt()
      } : null;
      hostCorpseState = hostCorpse;
      gamePublic = { ...(gamePublic || {}), hostCorpse };
      renderMap();
      void set(ref(db, `${BASE_PATH}/public/hostCorpse`), hostCorpse)
        .catch(error => console.warn("[DP game] host corpse runtime write failed", error));
      void publishHelpTargetsNow();
      return;
    }

    const forceStatus = String(payload.forceStatus || "");
    const nextStatus = forceStatus || String(existing.status || "admitted");
    await updateEntranceStatus(uid, nextStatus, {
      ...existing,
      ...runtime,
      name: String(payload.name || existing.name || payload.displayName || uid),
      role: String(payload.role || existing.role || "guest"),
      color: String(payload.color || existing.color || "#cccccc"),
      emoji: String(payload.emoji || existing.emoji || ""),
      runId: currentRunId(),
      runStartedAt: currentRunStartedAt()
    });

    const mapX = Number(payload.mapX);
    const mapY = Number(payload.mapY);
    if (payload.bodyPresent !== false && Number.isFinite(mapX) && Number.isFinite(mapY)) {
      const currentPoint = bridgePoints.get(uid) || {};
      const localX = clamp01(mapX);
      const localY = clamp01(mapY);
      const screen = screenFromMapLocal(localX, localY);
      const runtimeBodyState = String(runtime.bodyState || "alive").toLowerCase();
      const preserveHelpCommand = runtimeBodyState === "helping";
      const preservedRequestedAt = Number(
        currentPoint.requestedAt || payload.requestedAt || currentPoint.ts || Date.now()
      );
      const checkpointTargetId = Object.prototype.hasOwnProperty.call(payload, "targetId")
        ? (payload.targetId ? String(payload.targetId) : null)
        : (currentPoint.targetId ? String(currentPoint.targetId) : null);
      const frozenPoint = {
        ...currentPoint,
        id: uid,
        name: String(payload.name || existing.name || currentPoint.name || "\u0427\u0443\u0436\u043E\u0439"),
        color: String(payload.color || existing.color || currentPoint.color || "#cccccc"),
        emoji: String(payload.emoji || existing.emoji || currentPoint.emoji || ""),
        x: screen.x,
        y: screen.y,
        mapX: localX,
        mapY: localY,
        // \u041A\u043E\u0433\u0434\u0430 \u0437\u0440\u0438\u0442\u0435\u043B\u044C \u0443\u0436\u0435 \u043D\u0430\u0447\u0430\u043B \u043F\u043E\u043C\u043E\u0449\u044C, \u044D\u0442\u043E \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u0440\u0438\u0448\u043B\u043E \u043E\u0442 \u0441\u0430\u043C\u043E\u0439 \u0438\u0433\u0440\u044B,
        // \u0430 \u043D\u0435 \u043E\u0442 \u043D\u043E\u0432\u043E\u0433\u043E \u043A\u043B\u0438\u043A\u0430 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F. \u0420\u0430\u043D\u044C\u0448\u0435 \u043C\u044B \u0441\u0442\u0438\u0440\u0430\u043B\u0438 targetId \u0438
        // \u043C\u0435\u043D\u044F\u043B\u0438 requestedAt, Godot \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u043B \u044D\u0442\u043E \u0437\u0430 \u043D\u043E\u0432\u0443\u044E \u043A\u043E\u043C\u0430\u043D\u0434\u0443 \u0438 \u043E\u0442\u043C\u0435\u043D\u044F\u043B
        // \u043F\u043E\u043C\u043E\u0449\u044C \u0447\u0435\u0440\u0435\u0437 1\u20132 \u0441\u0435\u043A\u0443\u043D\u0434\u044B.
        targetId: checkpointRestore
          ? checkpointTargetId
          : (preserveHelpCommand
            ? (currentPoint.targetId ? String(currentPoint.targetId) : null)
            : (["dying", "dead", "being_helped", "reviving"].includes(runtimeBodyState)
              ? null
              : (currentPoint.targetId ? String(currentPoint.targetId) : null))),
        moveMode: "walk",
        bodyState: runtimeBodyState,
        bodyPresent: runtime.bodyPresent !== false,
        // Любой participant_runtime_state приходит ОТ ИГРЫ. Это никогда не новый
        // клик зрителя, поэтому serial команды карты не меняем вообще. Иначе
        // после checkpoint живой runtime-пакет выглядел как клик по старому месту
        // смерти: гость вставал, шёл туда и только потом возвращался в кресло.
        userCommandAt: Number(currentPoint.userCommandAt || currentPoint.requestedAt || preservedRequestedAt),
        requestedAt: preservedRequestedAt,
        ts: Number(currentPoint.ts || preservedRequestedAt),
        lastActive: Date.now(),
        runId: currentRunId(),
        runStartedAt: currentRunStartedAt()
      };
      bridgePoints.set(uid, frozenPoint);
      void set(ref(db, `${GAME_POINTS_PATH}/${uid}`), frozenPoint)
        .catch(error => console.warn("[DP game] frozen body point write failed", error));
      renderMap();
      scheduleSnapshotToGame();
    }
    return;
  }

  if (type === "guest_arrived" || type === "guest_waiting_door_open") {
    const uid = String(payload.uid || "");
    if (!uid) return;
    await updateEntranceStatus(uid, "waiting", {
      ...payload,
      doorOpenBlocked: Boolean(payload.doorOpen ?? type === "guest_waiting_door_open")
    });
    return;
  }

  if (type === "complete_exit" || type === "exit_complete") {
    const uid = String(payload.uid || "");
    if (!uid) return;

    // \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043C\u0433\u043D\u043E\u0432\u0435\u043D\u043D\u043E \u043C\u0435\u043D\u044F\u0435\u043C \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0442\u0430\u0442\u0443\u0441 \u0438 \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441. \u0420\u0430\u043D\u044C\u0448\u0435 \u043C\u044B \u0441\u043F\u0435\u0440\u0432\u0430
    // \u0436\u0434\u0430\u043B\u0438 \u0443\u0434\u0430\u043B\u0435\u043D\u0438\u044F \u0442\u043E\u0447\u043A\u0438 \u0438\u0437 Firebase; \u043F\u0440\u0438 \u043C\u0435\u0434\u043B\u0435\u043D\u043D\u043E\u043C \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0438 \u0437\u0440\u0438\u0442\u0435\u043B\u044C
    // \u043D\u0430\u0432\u0435\u0447\u043D\u043E \u0432\u0438\u0434\u0435\u043B \u00AB\u0418\u0414\u0401\u0428\u042C \u0412 \u041A\u041E\u0420\u0418\u0414\u041E\u0420\u2026\u00BB, \u0430 Godot \u043F\u043E\u043B\u0443\u0447\u0430\u043B \u0441\u0442\u0430\u0440\u043E\u0435 leaving.
    completedExitTombstones.set(uid, Date.now());
    broadcastLocalState("exit_complete", { uid });
    const statusWrite = updateEntranceStatus(uid, "outside", {
      ...payload,
      doorOpenBlocked: false,
      targetId: null,
      moveMode: "walk",
      bodyState: "outside",
      controllerState: "detached",
      exitRequested: false,
      bodyPresent: false
    });

    bridgePoints.delete(uid);
    runtimeStates.delete(uid);
    helpTargets.delete(uid);
    renderAdmissionUi();
    renderMap();
    scheduleSnapshotToGame();

    void remove(ref(db, `${GAME_POINTS_PATH}/${uid}`)).catch(() => {});
    await statusWrite;
    return;
  }

  if (type === "begin_admission") {
    const uid = String(payload.uid || "");
    if (!uid) return;
    await updateEntranceStatus(uid, "entering", {
      ...payload,
      doorOpenBlocked: false,
      bodyState: "alive",
      controllerState: "attached",
      exitRequested: false,
      bodyPresent: true
    });
    return;
  }

  if (type === "complete_admission" || type === "admit_player") {
    const uid = String(payload.uid || "");
    if (!uid) return;
    await updateEntranceStatus(uid, "admitted", {
      ...payload,
      doorOpenBlocked: false,
      bodyState: String(payload.bodyState || "alive"),
      controllerState: "attached",
      exitRequested: false,
      bodyPresent: true,
      mapX: clamp01(payload.mapX ?? gamePublic?.entrySpawn?.mapX ?? 0.5),
      mapY: clamp01(payload.mapY ?? gamePublic?.entrySpawn?.mapY ?? 0.88)
    });
    return;
  }

  if (type === "fake_message") {
    const masked = findParticipant({ role: payload.maskRole || "", name: payload.maskName || "" }) || {};
    const role = String(payload.maskRole || masked.role || "guest");
    const item = {
      source: "game",
      maskUid: masked.uid || "",
      maskRole: role,
      maskName: masked.name || payload.maskName || DEFAULT_NICK_BY_ROLE[role] || "\u0427\u0443\u0436\u043E\u0439",
      maskColor: masked.color || "#cccccc",
      maskEmoji: masked.emoji || "",
      text: String(payload.text || ""),
      createdAt: Date.now(),
      t: serverTimestamp()
    };
    await set(push(ref(db, `${BASE_PATH}/messages`)), item);
    return;
  }

  if (type === "private_event") {
    const explicitUid = String(payload.targetUid || "");
    const target = explicitUid
      ? { uid: explicitUid }
      : findParticipant({ role: payload.targetRole || "", name: payload.targetName || "" });
    if (!target?.uid) {
      console.warn("[DP game] private target not found", payload.targetRole || payload.targetName);
      return;
    }
    await set(push(ref(db, `${BASE_PATH}/private/${target.uid}`)), {
      text: String(payload.text || ""),
      createdAt: Date.now(),
      sceneId: gamePublic.sceneId || ""
    });
    return;
  }

  if (type === "spawn_entity") {
    const id = String(payload.id || crypto.randomUUID());
    const mapX = clamp01(payload.mapX ?? 0.5);
    const mapY = clamp01(payload.mapY ?? 0.5);
    const screen = screenFromMapLocal(mapX, mapY);
    await set(ref(db, `${BASE_PATH}/entities/${id}`), {
      ...payload,
      id,
      mapX,
      mapY,
      x: screen.x,
      y: screen.y,
      createdAt: Date.now()
    });
    return;
  }

  if (type === "clear_entity") {
    await remove(ref(db, `${BASE_PATH}/entities/${String(payload.id || "")}`));
    return;
  }

  if (type === "end_game") {
    broadcastLocalState("end_game", { active: false, runId: currentRunId() });
    await set(ref(db, BRIDGE_LIVE_PATH), {
      active: false,
      runId: currentRunId(),
      bridgeConnected: false,
      bridgeHeartbeatAt: Date.now()
    }).catch(() => {});
    await update(ref(db, BASE_PATH), {
      public: null, messages: null, private: null, entities: null, entrance: null,
      game_points: null, traitor_vote: null
    });
  }
}

function installBridge() {
  window.dpGameBridge = {
    version: ADAPTER_VERSION,
    getSnapshotJson: () => JSON.stringify(buildSnapshot()),
    getSnapshot: () => buildSnapshot(),
    receiveFromGame,
    nativeSocketState: () => nativeSocket?.readyState ?? WebSocket.CLOSED,
    reconnectNative: () => connectNativeSocket(true)
  };
}

function gameFrameWindow() {
  return document.getElementById("player")?.contentWindow || null;
}

let nativeSocket = null;
let nativeReconnectTimer = null;
let nativeReconnectAttempt = 0;
let gameDisconnectTimer = null;

function ensureNativeBridgeUi() {
  let root = document.getElementById("dp-native-bridge-status");
  if (root) return root;
  root = document.createElement("div");
  root.id = "dp-native-bridge-status";
  root.innerHTML = `
    <div class="card">
      <div class="title">DP HORROR \u00B7 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 \u043C\u043E\u0441\u0442</div>
      <div class="state">\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430\u2026</div>
      <div class="small">\u042D\u0442\u0443 \u0432\u043A\u043B\u0430\u0434\u043A\u0443 \u043C\u043E\u0436\u043D\u043E \u0441\u0432\u0435\u0440\u043D\u0443\u0442\u044C. \u041E\u043D\u0430 \u043F\u0435\u0440\u0435\u0434\u0430\u0451\u0442 Firebase \u2194 DPHorror.exe \u0447\u0435\u0440\u0435\u0437 ${escapeHtml(NATIVE_WS_URL)}.</div>
    </div>
  `;
  document.body.appendChild(root);
  return root;
}

function setNativeBridgeStatus(text, connected = false) {
  const root = ensureNativeBridgeUi();
  const stateEl = root.querySelector(".state");
  stateEl.textContent = text;
  stateEl.classList.toggle("ok", connected);
  document.title = connected ? "DP Bridge \u00B7 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E" : "DP Bridge \u00B7 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435";
}

function scheduleGameInactiveAfterDisconnect(reason = "socket closed") {
  if (gameDisconnectTimer) clearTimeout(gameDisconnectTimer);
  const disconnectedRunId = currentRunId();
  const disconnectedRunStartedAt = currentRunStartedAt();
  const wasActive = Boolean(gamePublic?.active);

  // Локально прячем карту немедленно. Firebase-проверка ниже всё ещё защищает
  // новый runId от случайного выключения старой вкладкой.
  if (wasActive) {
    gamePublic = {
      ...(gamePublic || {}),
      active: false,
      bridgeConnected: false,
      bridgeHeartbeatAt: Date.now()
    };
    renderAdmissionUi();
    renderMap();
  }

  console.warn("[DP game] native WebSocket disconnected; waiting before deactivating game", {
    reason,
    runId: disconnectedRunId,
    graceMs: GAME_DISCONNECT_GRACE_MS
  });

  gameDisconnectTimer = setTimeout(async () => {
    gameDisconnectTimer = null;
    if (nativeSocket?.readyState === WebSocket.OPEN) return;

    // \u041D\u0435 \u0433\u0430\u0441\u0438\u043C \u043F\u0443\u0441\u0442\u0443\u044E/\u0441\u0442\u0430\u0440\u0443\u044E \u0441\u0435\u0441\u0441\u0438\u044E. \u041E\u0441\u043E\u0431\u0435\u043D\u043D\u043E \u0432\u0430\u0436\u043D\u043E \u043F\u0440\u0438 \u0437\u0430\u043F\u0443\u0441\u043A\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B-\u043C\u043E\u0441\u0442\u0430
    // \u0440\u0430\u043D\u044C\u0448\u0435 \u0441\u0430\u043C\u043E\u0439 \u0438\u0433\u0440\u044B: \u043D\u0435\u0443\u0434\u0430\u0447\u043D\u0430\u044F \u043F\u043E\u043F\u044B\u0442\u043A\u0430 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F \u043D\u0435 \u0434\u043E\u043B\u0436\u043D\u0430 \u043F\u043E\u0437\u0436\u0435 \u0443\u0431\u0438\u0442\u044C
    // \u0443\u0436\u0435 \u0441\u0442\u0430\u0440\u0442\u043E\u0432\u0430\u0432\u0448\u0438\u0439 \u043D\u043E\u0432\u044B\u0439 runId.
    if (!wasActive || !disconnectedRunId) {
      console.log("[DP game] disconnect deactivation skipped: no active run was attached");
      return;
    }

    let remotePublic = null;
    try {
      const snapshot = await get(ref(db, `${BASE_PATH}/public`));
      remotePublic = snapshot.val() || {};
    } catch (error) {
      console.warn("[DP game] disconnect state check failed; keeping game active", error);
      return;
    }

    if (nativeSocket?.readyState === WebSocket.OPEN) return;
    if (String(remotePublic?.runId || "") !== disconnectedRunId) {
      console.log("[DP game] disconnect deactivation skipped: a newer run is active", {
        disconnectedRunId,
        currentRunId: String(remotePublic?.runId || "")
      });
      return;
    }

    helpTargets.clear();
    hostCorpseState = null;
    gamePublic = { ...(gamePublic || {}), active: false, helpTargets: [], hostCorpse: null };
    renderAdmissionUi();
    renderMap();
    try {
      await update(ref(db, `${BASE_PATH}/public`), {
        active: false,
        helpTargets: [],
        bridgeConnected: false,
        bridgeHeartbeatAt: Date.now(),
        disconnectedAt: serverTimestamp(),
        disconnectedRunId,
        disconnectedRunStartedAt,
        disconnectReason: String(reason || "socket closed")
      });
      console.warn("[DP game] game marked inactive after disconnect grace", {
        runId: disconnectedRunId,
        reason
      });
    } catch (error) {
      console.warn("[DP game] disconnect state write failed", error);
    }
  }, GAME_DISCONNECT_GRACE_MS);
}

function scheduleNativeReconnect() {
  if (!IS_NATIVE_BRIDGE || nativeReconnectTimer) return;
  const delay = Math.min(3000, 500 + nativeReconnectAttempt * 250);
  nativeReconnectTimer = setTimeout(() => {
    nativeReconnectTimer = null;
    connectNativeSocket();
  }, delay);
}

function connectNativeSocket(force = false) {
  if (!IS_NATIVE_BRIDGE) return;
  if (!force && nativeSocket && (
    nativeSocket.readyState === WebSocket.OPEN ||
    nativeSocket.readyState === WebSocket.CONNECTING
  )) return;

  if (force && nativeSocket) {
    try { nativeSocket.close(); } catch {}
    nativeSocket = null;
  }

  nativeReconnectAttempt += 1;
  setNativeBridgeStatus(`\u0418\u0449\u0443 \u0438\u0433\u0440\u0443: ${NATIVE_WS_URL}`);
  const socket = new WebSocket(NATIVE_WS_URL);
  nativeSocket = socket;

  socket.addEventListener("open", () => {
    if (nativeSocket !== socket) return;
    if (gameDisconnectTimer) {
      clearTimeout(gameDisconnectTimer);
      gameDisconnectTimer = null;
    }
    nativeReconnectAttempt = 0;
    setNativeBridgeStatus("\u0418\u0433\u0440\u0430 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0430. Firebase \u0438 Godot \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u0443\u044E\u0442\u0441\u044F.", true);
    socket.send(JSON.stringify({
      channel: "dp-horror",
      type: "bridge_ready",
      version: ADAPTER_VERSION
    }));
    postSnapshotToGame();
    console.log("[DP game] native WebSocket connected", NATIVE_WS_URL);
  });

  socket.addEventListener("message", event => {
    if (nativeSocket !== socket) return;
    let data = null;
    try { data = JSON.parse(String(event.data || "")); }
    catch (error) {
      console.warn("[DP game] native WebSocket bad JSON", error);
      return;
    }
    if (!data || data.channel !== "dp-horror") return;
    if (data.type === "game_ready") {
      setNativeBridgeStatus("\u0418\u0433\u0440\u0430 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0430. Firebase \u0438 Godot \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u0443\u044E\u0442\u0441\u044F.", true);
      postSnapshotToGame();
      return;
    }
    if (data.type === "game_event" && data.event) {
      if (!backendReady) pendingGameEvents.push(data.event);
      else void enqueueGameEvent(data.event);
    }
  });

  socket.addEventListener("close", event => {
    if (nativeSocket !== socket) return;
    nativeSocket = null;

    // Godot \u043D\u0430\u043C\u0435\u0440\u0435\u043D\u043D\u043E \u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0435\u0442 \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0443\u044E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443, \u043A\u043E\u0433\u0434\u0430 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u043B\u0430\u0441\u044C \u043D\u043E\u0432\u0430\u044F.
    // \u0422\u0430\u043A\u0430\u044F \u0432\u043A\u043B\u0430\u0434\u043A\u0430 \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u0434\u043E\u043B\u0436\u043D\u0430 \u0431\u043E\u0440\u043E\u0442\u044C\u0441\u044F \u0437\u0430 \u0441\u043E\u043A\u0435\u0442 \u0438 \u0442\u0435\u043C \u0431\u043E\u043B\u0435\u0435 \u0432\u044B\u043A\u043B\u044E\u0447\u0430\u0442\u044C \u0438\u0433\u0440\u0443.
    if (event.code === 1000 && event.reason === "new bridge page connected") {
      if (gameDisconnectTimer) {
        clearTimeout(gameDisconnectTimer);
        gameDisconnectTimer = null;
      }
      setNativeBridgeStatus("\u042D\u0442\u0443 \u0432\u043A\u043B\u0430\u0434\u043A\u0443 \u0437\u0430\u043C\u0435\u043D\u0438\u043B \u0434\u0440\u0443\u0433\u043E\u0439 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 \u043C\u043E\u0441\u0442.");
      console.warn("[DP game] bridge tab superseded; reconnect disabled");
      return;
    }

    setNativeBridgeStatus(`\u0418\u0433\u0440\u0430 \u043D\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0430. \u041F\u043E\u0432\u0442\u043E\u0440 \u0447\u0435\u0440\u0435\u0437 \u0441\u0435\u043A\u0443\u043D\u0434\u0443. \u041A\u043E\u0434: ${event.code || 0}`);
    scheduleGameInactiveAfterDisconnect(event.reason || `WebSocket code ${event.code || 0}`);
    scheduleNativeReconnect();
  });

  socket.addEventListener("error", () => {
    if (nativeSocket !== socket) return;
    setNativeBridgeStatus("\u0418\u0433\u0440\u0430 \u043F\u043E\u043A\u0430 \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430. \u0416\u0434\u0443 DPHorror.exe \u0438\u043B\u0438 F6\u2026");
  });
}

function postSnapshotToGame() {
  const payload = {
    channel: "dp-horror",
    type: "snapshot",
    snapshot: buildSnapshot()
  };

  if (IS_NATIVE_BRIDGE) {
    if (nativeSocket?.readyState === WebSocket.OPEN) {
      try { nativeSocket.send(JSON.stringify(payload)); }
      catch (error) { console.warn("[DP game] native snapshot failed", error); }
    }
    return;
  }

  if (!IS_GAME_HOST) return;
  const target = gameFrameWindow();
  if (!target) return;
  try {
    target.postMessage(payload, "*");
  } catch (error) {
    console.warn("[DP game] snapshot postMessage failed", error);
  }
}

function publishBridgeHeartbeat() {
  if (!IS_GAME_CONTROLLER || !backendReady || !db || !gamePublic?.active) return;
  const now = Date.now();
  if (now - lastBridgeHeartbeatWriteAt < GAME_HEARTBEAT_INTERVAL_MS - 100) return;
  lastBridgeHeartbeatWriteAt = now;
  gamePublic = {
    ...(gamePublic || {}),
    bridgeConnected: true,
    bridgeHeartbeatAt: now
  };
  const leasePayload = localHeartbeatPayload(now);
  broadcastLocalState("heartbeat", leasePayload);
  void set(ref(db, BRIDGE_LIVE_PATH), leasePayload)
    .catch(error => console.warn("[DP game] bridge lease heartbeat failed", error));
  void update(ref(db, `${BASE_PATH}/public`), {
    bridgeConnected: true,
    bridgeHeartbeatAt: now
  }).catch(error => console.warn("[DP game] heartbeat write failed", error));
}

function startSnapshotPump() {
  if (snapshotPumpStarted) return;
  snapshotPumpStarted = true;
  // \u0422\u043E\u043B\u044C\u043A\u043E \u0441\u0442\u0440\u0430\u0445\u043E\u0432\u043E\u0447\u043D\u044B\u0439 heartbeat. \u041A\u043E\u043E\u0440\u0434\u0438\u043D\u0430\u0442\u044B \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F \u0441\u043E\u0431\u044B\u0442\u0438\u0439\u043D\u043E
  // \u0438\u0437 Firebase callbacks \u0438 \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u0437\u0430\u0432\u0438\u0441\u044F\u0442 \u043E\u0442 \u0444\u043E\u043D\u043E\u0432\u043E\u0433\u043E setInterval.
  setInterval(() => {
    postSnapshotToGame();
    publishBridgeHeartbeat();
  }, GAME_HEARTBEAT_INTERVAL_MS);
}

window.addEventListener("message", event => {
  const data = event.data;
  if (!data || data.channel !== "dp-horror") return;
  const frame = gameFrameWindow();
  if (frame && event.source !== frame) return;

  if (data.type === "game_ready") {
    console.log("[DP game] Godot iframe ready", ADAPTER_VERSION);
    postSnapshotToGame();
    return;
  }

  if (data.type === "game_event" && data.event) {
    if (!backendReady) pendingGameEvents.push(data.event);
    else void enqueueGameEvent(data.event);
  }
});

installBridge();
startSnapshotPump();
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    scheduleSnapshotToGame();
    wakeMapAfterGameStart();
  }
});
window.addEventListener("focus", () => {
  scheduleSnapshotToGame();
  wakeMapAfterGameStart();
});


async function releaseHostIframeWhenSized() {
  if (!IS_GAME_HOST) return;
  const player = hostIframeGate?.player || document.getElementById("player");
  const wrap = document.getElementById("videoWrap");
  if (!player || !wrap) return;

  // \u0416\u0434\u0451\u043C \u0434\u0432\u0430 \u043F\u043E\u0441\u043B\u0435\u0434\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u043D\u044B\u0445 \u043A\u0430\u0434\u0440\u0430 \u0441 \u043D\u043E\u0440\u043C\u0430\u043B\u044C\u043D\u044B\u043C \u043D\u0435\u043D\u0443\u043B\u0435\u0432\u044B\u043C \u0440\u0430\u0437\u043C\u0435\u0440\u043E\u043C.
  let stableFrames = 0;
  for (let attempt = 0; attempt < 180; attempt++) {
    const rect = wrap.getBoundingClientRect();
    if (rect.width >= 320 && rect.height >= 180) stableFrames += 1;
    else stableFrames = 0;
    if (stableFrames >= 2) break;
    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  const rect = wrap.getBoundingClientRect();
  console.log("[DP game] releasing Godot iframe", {
    width: Math.round(rect.width), height: Math.round(rect.height)
  });

  player.dataset.dpIframeReleased = "1";
  hostIframeGate?.observer?.disconnect();
  player.style.visibility = "visible";
  player.setAttribute("src", GAME_BUILD_URL);
}

async function removeControllerVote() {
  const hostUid = window.__ccCanonicalUid?.() || auth?.currentUser?.uid || "";
  if (!hostUid) return;
  try { await remove(ref(db, `${POINTS_PATH}/${hostUid}`)); } catch {}
  try { state?.points?.delete?.(hostUid); } catch {}
}

function installEmergencyKey() {
  window.addEventListener("keydown", async event => {
    if (event.code !== "F10") return;
    event.preventDefault();
    await update(ref(db, BASE_PATH), {
      public: null, messages: null, private: null, entities: null, entrance: null,
      game_points: null, traitor_vote: null
    });
    showGameToast({ name: "SYSTEM", text: "\u0418\u0433\u0440\u043E\u0432\u043E\u0439 \u0440\u0435\u0436\u0438\u043C \u0430\u0432\u0430\u0440\u0438\u0439\u043D\u043E \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D", emoji: "\u26D4", color: "#ff547f" });
  });
}

async function activateHostMode() {
  if (!IS_GAME_HOST) return;
  document.body.classList.add("game-host-mode");
  await removeControllerVote();
  const chatPanel = document.getElementById("chatPanel");
  if (chatPanel) chatPanel.style.display = "none";
  await releaseHostIframeWhenSized();
  installEmergencyKey();
}

async function activateNativeBridgeMode() {
  if (!IS_NATIVE_BRIDGE) return;
  document.body.classList.add("native-bridge-mode");
  ensureNativeBridgeUi();
  await removeControllerVote();

  const player = document.getElementById("player");
  if (player) {
    try { player.src = "about:blank"; } catch {}
  }

  connectNativeSocket();
  installEmergencyKey();
  window.addEventListener("beforeunload", () => {
    try { nativeSocket?.close(1000, "bridge page closed"); } catch {}
  });
}

function boot() {
  if (!window.db || !window.auth || !window.state || !window.auth.currentUser || !window.state.authed) {
    setTimeout(boot, 100);
    return;
  }
  db = window.db;
  auth = window.auth;
  state = window.state;
  ensureUi();
  ensureLocalStateChannel();
  backendReady = true;
  bindFirebase();
  if (!IS_GAME_CONTROLLER) {
    setInterval(() => {
      if (
        lastLocalControllerPulseAt > 0 &&
        Date.now() - lastLocalControllerPulseAt > LOCAL_STATE_STALE_MS
      ) {
        lastLocalControllerPulseAt = 0;
        renderAdmissionUi();
        renderMap();
      }
    }, 1000);
  }
  renderAdmissionUi();
  monitorRealChatForHost();
  void activateHostMode();
  void activateNativeBridgeMode();
  while (pendingGameEvents.length) {
    void enqueueGameEvent(pendingGameEvents.shift());
  }
  postSnapshotToGame();
  console.log("[DP game] map adapter ready", {
    version: ADAPTER_VERSION,
    host: IS_GAME_HOST,
    nativeBridge: IS_NATIVE_BRIDGE,
    controller: IS_GAME_CONTROLLER,
    base: BASE_PATH,
    currentUid: window.__ccCanonicalUid?.() || auth?.currentUser?.uid || "",
    points: state?.points?.size ?? 0
  });
}

boot();
