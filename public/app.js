import { createFeedState } from "./feed-client.js";

let state = createFeedState();
let activeRoomId = null;

const statusEl = document.getElementById("status");
const listEl = document.getElementById("messages");
const formEl = document.getElementById("publish-form");
const inputEl = document.getElementById("content-input");
const roomInput = document.getElementById("room-input");
const connectBtn = document.getElementById("connect-btn");

const MAX_RECONNECT_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 30000;

let ws = null;
let reconnectAttempts = 0;
let manualDisconnect = false;
let reconnectTimer = null;

function sanitizeRoomId(raw) {
  const cleaned = (raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "demo-room";
}

function currentRoomId() {
  return sanitizeRoomId(roomInput.value);
}

function render() {
  listEl.innerHTML = "";
  for (const update of state.getMessages()) {
    const li = document.createElement("li");
    const time = new Date(update.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    li.innerHTML = `<span class="meta">#${update.seq}&nbsp;&middot;&nbsp;${time}</span><span class="body">${update.content}</span>`;
    listEl.appendChild(li);
  }
  listEl.scrollTop = listEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.dataset.state = text.split(" ")[0];
}

function wsUrl(roomId) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/api/rooms/${encodeURIComponent(roomId)}/ws`;
}

function connect() {
  clearTimeout(reconnectTimer);
  manualDisconnect = false;
  const roomId = currentRoomId();

  if (roomId !== activeRoomId) {
    state = createFeedState();
    activeRoomId = roomId;
    listEl.innerHTML = "";
  }

  setStatus(reconnectAttempts > 0 ? "reconnecting" : "connecting");
  ws = new WebSocket(wsUrl(roomId));

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    setStatus("connected");
    ws.send(JSON.stringify({ type: "hello", since: state.getLastSeq() }));
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "history") {
      state.applyHistory(message.updates);
      render();
    } else if (message.type === "update") {
      state.applyLive(message.update);
      render();
    } else if (message.type === "error") {
      console.error("Server error:", message.message);
    }
  });

  ws.addEventListener("close", () => {
    if (manualDisconnect) {
      setStatus("disconnected");
      return;
    }
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // The close handler (above) does the actual reconnect scheduling.
    ws && ws.close();
  });
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setStatus("disconnected (gave up \u2014 click Reconnect)");
    return;
  }
  reconnectAttempts += 1;
  setStatus("reconnecting");
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), MAX_BACKOFF_MS);
  reconnectTimer = setTimeout(connect, delay);
}

connectBtn.addEventListener("click", () => {
  reconnectAttempts = 0;
  if (ws) {
    manualDisconnect = true;
    ws.close();
  }
  connect();
});

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const content = inputEl.value.trim();
  if (!content || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "publish", content }));
  inputEl.value = "";
});

connect();
