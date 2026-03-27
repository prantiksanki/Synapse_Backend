// SYNAPSE WebRTC Signaling Server
// Run: npm install && node index.js
// Port: 3000 (or set PORT env var)
// MongoDB: set MONGODB_URI env var or defaults to mongodb://localhost:27017/synapse

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(express.json());

const PORT         = process.env.PORT         || 3000;
const MONGODB_URI  = process.env.MONGODB_URI  || 'mongodb://localhost:27017/synapse';

// ── MongoDB User schema ───────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:    { type: String, required: true, unique: true, trim: true },
  role:        { type: String, enum: ['deaf', 'caller'], required: true },
  displayName: { type: String, default: '' },
  language:    { type: String, default: 'english' },
  country:     { type: String, default: '' },
  createdAt:   { type: Date, default: Date.now },
  lastSeen:    { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

// Connect to MongoDB (non-blocking — server still starts if DB is down)
mongoose.connect(MONGODB_URI)
  .then(() => console.log(`[DB] Connected to MongoDB: ${MONGODB_URI}`))
  .catch((err) => console.warn(`[DB] MongoDB connection failed (in-memory mode active): ${err.message}`));

// ── In-memory real-time tracking (unchanged) ──────────────────────────────────
// users: username → { socketId, role: 'deaf'|'caller', status: 'online'|'in_call' }
const users = new Map();
// activeCalls: callId → { callerId, calleeId, callerSocketId, calleeSocketId }
const activeCalls = new Map();

function genCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function broadcastUserList() {
  const list = [];
  for (const [username, info] of users) {
    list.push({ username, role: info.role, status: info.status });
  }
  io.emit('user_list', list);
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── REGISTER ─────────────────────────────────────────────────────────────
  // Client emits: { username: string, role: 'deaf' | 'caller' }
  socket.on('register_user', async ({ username, role }) => {
    if (!username || !role) return;

    // Clean up any previous socket entry for this socket id
    for (const [u, info] of users) {
      if (info.socketId === socket.id) users.delete(u);
    }

    // Update in-memory map
    users.set(username, { socketId: socket.id, role, status: 'online' });
    socket.data.username = username;
    socket.data.role = role;

    socket.emit('registered', { username });
    broadcastUserList();
    console.log(`[R] ${username} (${role})`);

    // Persist to MongoDB (upsert)
    try {
      await User.findOneAndUpdate(
        { username },
        { role, lastSeen: new Date() },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      );
    } catch (err) {
      console.warn(`[DB] Upsert failed for ${username}: ${err.message}`);
    }
  });

  // ── CALL USER ─────────────────────────────────────────────────────────────
  socket.on('call_user', ({ targetUsername, callType }) => {
    const callerUsername = socket.data.username;
    if (!callerUsername) return socket.emit('error', { message: 'Not registered' });

    const target = users.get(targetUsername);
    if (!target) return socket.emit('call_rejected', { reason: 'User is offline' });
    if (target.status === 'in_call') return socket.emit('call_rejected', { reason: 'User is in another call' });

    const callId = genCallId();
    activeCalls.set(callId, {
      callerId: callerUsername,
      calleeId: targetUsername,
      callerSocketId: socket.id,
      calleeSocketId: target.socketId,
    });

    const caller = users.get(callerUsername);
    if (caller) caller.status = 'in_call';
    target.status = 'in_call';

    io.to(target.socketId).emit('incoming_call', {
      callId,
      callerUsername,
      callType: callType || 'audio',
    });
    socket.emit('call_initiated', { callId });
    broadcastUserList();
    console.log(`[CALL] ${callerUsername} -> ${targetUsername} (${callId})`);
  });

  // ── ACCEPT CALL ───────────────────────────────────────────────────────────
  socket.on('accept_call', ({ callId }) => {
    const call = activeCalls.get(callId);
    if (!call) return;
    io.to(call.callerSocketId).emit('call_accepted', { callId });
    console.log(`[ACC] ${callId}`);
  });

  // ── REJECT CALL ───────────────────────────────────────────────────────────
  socket.on('reject_call', ({ callId }) => {
    const call = activeCalls.get(callId);
    if (!call) return;
    io.to(call.callerSocketId).emit('call_rejected', { reason: 'Call was declined' });
    _endCall(callId);
    console.log(`[REJ] ${callId}`);
  });

  // ── END CALL ──────────────────────────────────────────────────────────────
  socket.on('end_call', ({ callId }) => {
    const call = activeCalls.get(callId);
    if (!call) return;
    io.to(call.callerSocketId).emit('call_ended', { callId });
    io.to(call.calleeSocketId).emit('call_ended', { callId });
    _endCall(callId);
    console.log(`[END] ${callId}`);
  });

  // ── WebRTC OFFER ──────────────────────────────────────────────────────────
  socket.on('offer', ({ callId, sdp }) => {
    const target = _getOtherSocket(callId, socket.id);
    if (target) io.to(target).emit('offer', { callId, sdp });
  });

  // ── WebRTC ANSWER ─────────────────────────────────────────────────────────
  socket.on('answer', ({ callId, sdp }) => {
    const target = _getOtherSocket(callId, socket.id);
    if (target) io.to(target).emit('answer', { callId, sdp });
  });

  // ── ICE CANDIDATE ─────────────────────────────────────────────────────────
  socket.on('ice_candidate', ({ callId, candidate }) => {
    const target = _getOtherSocket(callId, socket.id);
    if (target) io.to(target).emit('ice_candidate', { callId, candidate });
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const username = socket.data.username;
    if (!username) return;

    for (const [callId, call] of activeCalls) {
      if (call.callerSocketId === socket.id || call.calleeSocketId === socket.id) {
        const other = call.callerSocketId === socket.id
          ? call.calleeSocketId : call.callerSocketId;
        io.to(other).emit('call_ended', { callId });
        _endCall(callId);
      }
    }

    users.delete(username);
    broadcastUserList();
    console.log(`[-] Disconnected: ${username}`);

    // Update lastSeen in MongoDB
    try {
      await User.findOneAndUpdate({ username }, { lastSeen: new Date() });
    } catch (_) {}
  });
});

function _getOtherSocket(callId, mySocketId) {
  const call = activeCalls.get(callId);
  if (!call) return null;
  return mySocketId === call.callerSocketId ? call.calleeSocketId : call.callerSocketId;
}

function _endCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) return;
  if (users.get(call.callerId)) users.get(call.callerId).status = 'online';
  if (users.get(call.calleeId)) users.get(call.calleeId).status = 'online';
  activeCalls.delete(callId);
  broadcastUserList();
}

// ── REST API ──────────────────────────────────────────────────────────────────

// Health / live status (unchanged)
app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    users: users.size,
    calls: activeCalls.size,
    online: [...users.entries()].map(([u, i]) => ({ username: u, role: i.role, status: i.status })),
  });
});

// All registered users from MongoDB
app.get('/users', async (_, res) => {
  try {
    const all = await User.find({}, { __v: 0 }).sort({ lastSeen: -1 });
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single user profile
app.get('/users/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username }, { __v: 0 });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user profile (display name, language, country, role)
app.put('/users/:username', async (req, res) => {
  const { displayName, language, country, role } = req.body;
  const allowed = {};
  if (displayName !== undefined) allowed.displayName = displayName;
  if (language    !== undefined) allowed.language    = language;
  if (country     !== undefined) allowed.country     = country;
  if (role        !== undefined && ['deaf', 'caller'].includes(role)) allowed.role = role;
  allowed.lastSeen = new Date();

  try {
    const updated = await User.findOneAndUpdate(
      { username: req.params.username },
      { $set: allowed },
      { new: true, runValidators: true, projection: { __v: 0 } },
    );
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a user from MongoDB (admin / testing)
app.delete('/users/:username', async (req, res) => {
  try {
    const result = await User.findOneAndDelete({ username: req.params.username });
    if (!result) return res.status(404).json({ error: 'User not found' });
    res.json({ deleted: result.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`SYNAPSE Signaling Server running on http://0.0.0.0:${PORT}`);
  console.log(`Health:  GET http://localhost:${PORT}/health`);
  console.log(`Users:   GET http://localhost:${PORT}/users`);
});
