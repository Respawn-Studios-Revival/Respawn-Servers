const { WebSocketServer } = require("ws");
const wss = new WebSocketServer({ port: process.env.PORT || 3000 });
const rooms = {};
const roomPublicVars = {}; // room -> { name: value } — server is the single source of truth

// Position-style updates (private/public vars) are frequent and always superseded by the
// next update, so if a peer's outgoing socket is backed up we drop the stale one instead of
// queuing — queuing is what caused updates to arrive tens of seconds late in busy rooms.
const BACKPRESSURE_LIMIT = 64 * 1024;
function sendDroppable(peer, out) {
  if (peer.bufferedAmount > BACKPRESSURE_LIMIT) return;
  peer.send(out);
}

wss.on("connection", (ws) => {
  let myRoom = null, myId = null;
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === "join") {
      myRoom = msg.room; myId = msg.id;
      if (!rooms[myRoom]) rooms[myRoom] = new Map();
      if (!roomPublicVars[myRoom]) roomPublicVars[myRoom] = {};
      const existing = [...rooms[myRoom].keys()];
      rooms[myRoom].set(myId, ws);
      ws.send(JSON.stringify({ type: "peers", ids: existing }));
      // Catch the newcomer up on the room's current public variables right away
      ws.send(JSON.stringify({ type: "public_vars_snapshot", vars: roomPublicVars[myRoom] }));
      existing.forEach(id => rooms[myRoom].get(id)?.send(JSON.stringify({ type: "joined", id: myId })));
    } else if (msg.type === "leave") {
      cleanup();
    } else if (msg.type === "var_public_create") {
      if (!myRoom) return;
      const vars = roomPublicVars[myRoom] || (roomPublicVars[myRoom] = {});
      // Only initialize if nobody has created it yet — never resets an existing value
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
    } else if (["offer","answer","ice"].includes(msg.type)) {
      rooms[myRoom]?.get(msg.to)?.send(JSON.stringify({ ...msg, from: myId }));
    } else if (myRoom) {
      // Generic broadcast: relay any other message type to all other peers in the room.
      // Stringify once and reuse — re-stringifying per recipient wastes CPU and, with
      // frequent updates (e.g. per-frame private variable syncs), was adding delay as
      // rooms grew past 2 people.
      const out = JSON.stringify({ ...msg, from: myId });
      const droppable = msg.type === "var_private" || msg.type === "var_private_batch";
      rooms[myRoom]?.forEach((peer, id) => {
        if (id === myId) return;
        if (droppable) sendDroppable(peer, out);
        else peer.send(out);
      });
    }
  });
  function cleanup() {
    if (!myRoom || !myId) return;
    rooms[myRoom]?.delete(myId);
    const out = JSON.stringify({ type: "left", id: myId });
    rooms[myRoom]?.forEach(peer => peer.send(out));
    if (rooms[myRoom]?.size === 0) { delete rooms[myRoom]; delete roomPublicVars[myRoom]; }
    myRoom = null; myId = null;
  }
  ws.on("close", cleanup);
});
