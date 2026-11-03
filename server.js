const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;           // e.g. https://abcdxyz.supabase.co
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MAX_GAME_BYTES = 5 * 1024 * 1024;
const MAX_PAYLOAD = 6 * 1024 * 1024;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn("SUPABASE_URL / SUPABASE_ANON_KEY not set: login and games are disabled.");
}

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_PAYLOAD });

const rooms = {};              // roomKey -> Map(id -> ws)
const roomPublicVars = {};     // roomKey -> { name: value } (server is the source of truth)
const gameInstances = {};      // gameId -> Set(roomKey)

// Position-style updates are superseded by the next one, so drop them for slow peers instead of queuing.
const BACKPRESSURE_LIMIT = 64 * 1024;
function sendDroppable(peer, out) {
  if (peer.bufferedAmount > BACKPRESSURE_LIMIT) return;
  peer.send(out);
}
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- Supabase ----------
async function sbFetch(path, { token, method = "GET", body, prefer } = {}) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + (token || SUPABASE_ANON_KEY) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(SUPABASE_URL + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch (e) { j = text; }
  if (!res.ok) throw new Error((j && (j.message || j.msg || j.error_description)) || ("Supabase error " + res.status));
  return j;
}

async function verifyToken(token) {
  const u = await sbFetch("/auth/v1/user", { token });
  return { id: u.id, email: u.email || "" };
}

async function fetchUsername(userId) {
  if (!isUuid(userId)) return null;
  const rows = await sbFetch("/rest/v1/profiles?id=eq." + userId + "&select=username");
  return rows && rows[0] ? rows[0].username : null;
}

const isUuid = s => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Game list cache (metadata only, no game data) so the lobby doesn't hit Supabase every request
let gamesCache = { at: 0, rows: [] };
async function getGameRows() {
  if (Date.now() - gamesCache.at < 15000) return gamesCache.rows;
  const rows = await sbFetch("/rest/v1/games?select=id,title,description,thumbnail,max_players,owner,updated_at&order=updated_at.desc&limit=200");
  gamesCache = { at: Date.now(), rows };
  return rows;
}
function invalidateGames() { gamesCache.at = 0; }

// ---------- Instances ----------
function playerCount(gameId) {
  let n = 0;
  const set = gameInstances[gameId];
  if (!set) return 0;
  for (const key of set) n += rooms[key]?.size || 0;
  return n;
}

function pickInstance(gameId, maxPlayers) {
  const set = gameInstances[gameId] || (gameInstances[gameId] = new Set());
  for (const key of [...set]) {
    const size = rooms[key]?.size || 0;
    if (size === 0) { set.delete(key); continue; }
    if (size < maxPlayers) return key;
  }
  const key = gameId + "#" + crypto.randomBytes(4).toString("hex");
  set.add(key);
  return key;
}

// ---------- Rooms (the original relay, unchanged in behavior) ----------
function joinRoom(ws, room, id) {
  ws.room = room;
  ws.id = id;
  if (!rooms[room]) rooms[room] = new Map();
  if (!roomPublicVars[room]) roomPublicVars[room] = {};
  const existing = [...rooms[room].keys()];
  const names = {};
  rooms[room].forEach((peer, pid) => { names[pid] = peer.username || null; });
  const old = rooms[room].get(id);
  if (old && old !== ws) { old.room = null; old.id = null; try { old.close(); } catch (e) { } }
  rooms[room].set(id, ws);
  send(ws, { type: "peers", ids: existing, names });
  send(ws, { type: "public_vars_snapshot", vars: roomPublicVars[room] });
  existing.forEach(pid => { const p = rooms[room].get(pid); if (p) send(p, { type: "joined", id, username: ws.username || null }); });
}

function cleanup(ws) {
  const room = ws.room, id = ws.id;
  if (!room || !id) return;
  if (rooms[room]?.get(id) === ws) rooms[room].delete(id);
  const out = JSON.stringify({ type: "left", id });
  rooms[room]?.forEach(peer => { if (peer.readyState === 1) peer.send(out); });
  if (rooms[room]?.size === 0) { delete rooms[room]; delete roomPublicVars[room]; }
  ws.room = null;
  ws.id = null;
}

function handleRelay(ws, msg) {
  const myRoom = ws.room, myId = ws.id;
  if (msg.type === "join") {
    joinRoom(ws, msg.room, msg.id);
  } else if (msg.type === "leave") {
    cleanup(ws);
  } else if (msg.type === "var_public_create") {
    if (!myRoom) return;
    const vars = roomPublicVars[myRoom] || (roomPublicVars[myRoom] = {});
    if (!Object.prototype.hasOwnProperty.call(vars, msg.name)) vars[msg.name] = 0;
    const out = JSON.stringify({ type: "var_public", name: msg.name, value: vars[msg.name] });
    rooms[myRoom]?.forEach(peer => peer.send(out));
  } else if (msg.type === "var_public_set") {
    if (!myRoom) return;
    const vars = roomPublicVars[myRoom] || (roomPublicVars[myRoom] = {});
    vars[msg.name] = msg.value;
    const out = JSON.stringify({ type: "var_public", name: msg.name, value: msg.value });
    rooms[myRoom]?.forEach(peer => sendDroppable(peer, out));
  } else if (msg.type === "var_public_change") {
    if (!myRoom) return;
    const vars = roomPublicVars[myRoom] || (roomPublicVars[myRoom] = {});
    const next = (Number(vars[msg.name]) || 0) + (Number(msg.delta) || 0);
    vars[msg.name] = next;
    const out = JSON.stringify({ type: "var_public", name: msg.name, value: next });
    rooms[myRoom]?.forEach(peer => peer.send(out));
  } else if (["offer", "answer", "ice"].includes(msg.type)) {
    const target = rooms[myRoom]?.get(msg.to);
    if (target) send(target, { ...msg, from: myId });
  } else if (myRoom) {
    const out = JSON.stringify({ ...msg, from: myId, username: ws.username || null });
    const droppable = msg.type === "var_private" || msg.type === "var_private_batch" || msg.type === "player_state";
    rooms[myRoom]?.forEach((peer, id) => {
      if (id === myId) return;
      if (droppable) sendDroppable(peer, out);
      else peer.send(out);
    });
  }
}

// ---------- Game and account handlers ----------
async function handleAuth(ws, msg) {
  if (!SUPABASE_URL) return send(ws, { type: "auth_fail", message: "Accounts are not set up on the server." });
  try {
    const user = await verifyToken(msg.token);
    user.username = (await fetchUsername(user.id)) || null;
    ws.user = user;
    ws.username = user.username;
    ws.token = msg.token;
    send(ws, { type: "auth_ok", user });
  } catch (e) {
    ws.user = null;
    ws.token = null;
    send(ws, { type: "auth_fail", message: e.message });
  }
}

async function handleList(ws) {
  const rows = await getGameRows();
  const games = rows.map(g => ({ ...g, players: playerCount(g.id) }));
  send(ws, { type: "games", games });
}

async function handleGet(ws, msg) {
  if (!isUuid(msg.id)) return send(ws, { type: "error", request: "get_game", message: "Bad game id." });
  const rows = await sbFetch("/rest/v1/games?id=eq." + msg.id + "&select=*");
  if (!rows.length) return send(ws, { type: "error", request: "get_game", message: "Game not found." });
  send(ws, { type: "game", game: rows[0] });
}

async function handleJoinGame(ws, msg) {
  if (!isUuid(msg.id)) return send(ws, { type: "error", request: "join_game", message: "Bad game id." });
  const rows = await getGameRows();
  const g = rows.find(r => r.id === msg.id);
  if (!g) return send(ws, { type: "error", request: "join_game", message: "Game not found." });
  if (ws.room) cleanup(ws);
  const roomKey = pickInstance(g.id, g.max_players || 10);
  const id = ws.user ? ws.user.id : "guest-" + crypto.randomBytes(6).toString("hex");
  joinRoom(ws, roomKey, id);
  send(ws, { type: "game_joined", gameId: g.id, room: roomKey, id, players: rooms[roomKey].size });
}

function validateGameFields(m, partial) {
  const out = {};
  if (!partial || m.title !== undefined) {
    if (typeof m.title !== "string" || !m.title.trim() || m.title.length > 80) throw new Error("Title must be 1-80 characters.");
    out.title = m.title.trim();
  }
  if (m.description !== undefined) {
    if (typeof m.description !== "string" || m.description.length > 1000) throw new Error("Description must be 1000 characters or less.");
    out.description = m.description;
  }
  if (m.thumbnail !== undefined) {
    if (typeof m.thumbnail !== "string" || m.thumbnail.length > 500) throw new Error("Thumbnail must be a URL.");
    out.thumbnail = m.thumbnail;
  }
  if (m.max_players !== undefined) {
    const n = Number(m.max_players);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("Max players must be 1-50.");
    out.max_players = n;
  }
  if (m.data !== undefined) {
    if (!m.data || typeof m.data !== "object") throw new Error("Game data must be a JSON object.");
    if (JSON.stringify(m.data).length > MAX_GAME_BYTES) throw new Error("Game is over 5 MB.");
    out.data = m.data;
  }
  return out;
}

async function handleGameWrite(ws, msg) {
  if (!ws.token) return send(ws, { type: "error", request: msg.type, message: "Log in first." });
  const token = ws.token;

  if (msg.type === "publish_game") {
    const fields = validateGameFields(msg, false);
    if (!fields.data) throw new Error("Game data is required.");
    const body = { owner: ws.user.id, description: "", thumbnail: "", max_players: 10, ...fields };
    const rows = await sbFetch("/rest/v1/games", { token, method: "POST", body, prefer: "return=representation" });
    invalidateGames();
    return send(ws, { type: "game_published", game: rows[0] });
  }

  if (msg.type === "update_game") {
    if (!isUuid(msg.id)) throw new Error("Bad game id.");
    const fields = validateGameFields(msg, true);
    if (!Object.keys(fields).length) throw new Error("Nothing to update.");
    const rows = await sbFetch("/rest/v1/games?id=eq." + msg.id, { token, method: "PATCH", body: fields, prefer: "return=representation" });
    if (!rows.length) throw new Error("Not found, or you don't own this game.");
    invalidateGames();
    return send(ws, { type: "game_updated", game: rows[0] });
  }

  if (msg.type === "delete_game") {
    if (!isUuid(msg.id)) throw new Error("Bad game id.");
    const rows = await sbFetch("/rest/v1/games?id=eq." + msg.id, { token, method: "DELETE", prefer: "return=representation" });
    if (!rows.length) throw new Error("Not found, or you don't own this game.");
    invalidateGames();
    return send(ws, { type: "game_deleted", id: msg.id });
  }
}

// ---------- Connections ----------
wss.on("connection", ws => {
  ws.room = null;
  ws.id = null;
  ws.user = null;
  ws.token = null;
  ws.username = null;

  ws.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    try {
      switch (msg.type) {
        case "auth": return await handleAuth(ws, msg);
        case "list_games": return await handleList(ws);
        case "get_game": return await handleGet(ws, msg);
        case "join_game": return await handleJoinGame(ws, msg);
        case "publish_game":
        case "update_game":
        case "delete_game": return await handleGameWrite(ws, msg);
        default: return handleRelay(ws, msg);
      }
    } catch (err) {
      send(ws, { type: "error", request: msg.type, message: err.message || String(err) });
    }
  });

  ws.on("close", () => cleanup(ws));
});

console.log("Respawn server listening on port " + PORT);
