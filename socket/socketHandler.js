const User = require('../models/User');
const { Message, Conversation } = require('../models/Chat');
const Notification = require('../models/Notification');

module.exports = (io, app) => {
  const onlineUsers = app.get('onlineUsers'); // userId -> socketId

  io.on('connection', (socket) => {
    // ── ONLINE ─────────────────────────────────────────────
    socket.on('user:online', async (userId) => {
      if (!userId) return;
      onlineUsers.set(userId, socket.id);
      socket.userId = userId;
      await User.findByIdAndUpdate(userId, { isOnline: true, socketId: socket.id, lastSeen: new Date() });
      io.emit('user:status', { userId, isOnline: true });
    });

    // ── CONVERSATIONS ───────────────────────────────────────
    socket.on('conversation:join',  (id) => socket.join(id));
    socket.on('conversation:leave', (id) => socket.leave(id));

    // ── MESSAGES ────────────────────────────────────────────
    socket.on('message:send', async ({ conversationId, message }) => {
      // Relay to everyone in room
      socket.to(conversationId).emit('message:new', message);

      // Update unread count for offline participants
      try {
        const conv = await Conversation.findById(conversationId);
        if (conv) {
          conv.participants.forEach(p => {
            const pid = p.toString();
            if (pid !== socket.userId) {
              const ts = onlineUsers.get(pid);
              io.to(ts || '').emit('chat:unread:increment', { conversationId });
            }
          });
        }
      } catch {}
    });

    socket.on('message:edit',   (data) => socket.to(data.conversationId).emit('message:edited',  data));
    socket.on('message:delete', (data) => socket.to(data.conversationId).emit('message:deleted', data));
    socket.on('message:react',  (data) => io.to(data.conversationId).emit('message:reacted',     data));

    // ── TYPING ──────────────────────────────────────────────
    socket.on('typing:start', ({ conversationId }) =>
      socket.to(conversationId).emit('typing:started', { userId: socket.userId, conversationId }));
    socket.on('typing:stop', ({ conversationId }) =>
      socket.to(conversationId).emit('typing:stopped', { userId: socket.userId, conversationId }));

    // ── READ ────────────────────────────────────────────────
    socket.on('message:read', ({ conversationId }) =>
      socket.to(conversationId).emit('message:seen', { userId: socket.userId, conversationId }));

    // ── NOTIFICATIONS ────────────────────────────────────────
    // Called from routes via io directly; this handles client-side ack
    socket.on('notification:ack', () => {}); // placeholder

    // ── POSTS (real-time like/comment broadcast) ─────────────
    socket.on('post:like',    (data) => io.emit('post:like:update',    data));
    socket.on('post:comment', (data) => io.emit('post:comment:update', data));
    socket.on('reel:like',    (data) => io.emit('reel:like:update',    data));

    // ── FOLLOW ──────────────────────────────────────────────
    socket.on('user:follow', ({ targetUserId, data }) => {
      const ts = onlineUsers.get(targetUserId);
      if (ts) io.to(ts).emit('follow:request', data);
    });
    socket.on('user:follow:accepted', ({ targetUserId, data }) => {
      const ts = onlineUsers.get(targetUserId);
      if (ts) io.to(ts).emit('follow:accepted', data);
    });

    // ── WEBRTC CALLS ─────────────────────────────────────────
    socket.on('call:initiate', ({ targetUserId, callType, conversationId, callerInfo }) => {
      const ts = onlineUsers.get(targetUserId);
      if (ts) io.to(ts).emit('call:incoming', { callType, conversationId, callerInfo, callerId: socket.userId });
    });
    socket.on('call:accept', ({ callerId, conversationId }) => {
      const cs = onlineUsers.get(callerId);
      if (cs) io.to(cs).emit('call:accepted', { accepterId: socket.userId, conversationId });
    });
    socket.on('call:reject', ({ callerId }) => {
      const cs = onlineUsers.get(callerId);
      if (cs) io.to(cs).emit('call:rejected', {});
    });
    socket.on('call:end', ({ targetUserId }) => {
      const ts = onlineUsers.get(targetUserId);
      if (ts) io.to(ts).emit('call:ended', { endedBy: socket.userId });
    });
    // WebRTC signaling relay (for SimplePeer)
    socket.on('call:signal', ({ targetUserId, signal }) => {
      const ts = onlineUsers.get(targetUserId);
      if (ts) io.to(ts).emit('call:signal', { signal, from: socket.userId });
    });
    socket.on('call:ice', ({ targetUserId, candidate }) => {
      const ts = onlineUsers.get(targetUserId);
      if (ts) io.to(ts).emit('call:ice', { candidate, from: socket.userId });
    });

    // ── STORY ────────────────────────────────────────────────
    socket.on('story:viewed', ({ authorId }) => {
      const ts = onlineUsers.get(authorId);
      if (ts) io.to(ts).emit('story:view:new', { viewerId: socket.userId });
    });

    // ── DISCONNECT ───────────────────────────────────────────
    socket.on('disconnect', async () => {
      if (socket.userId) {
        onlineUsers.delete(socket.userId);
        await User.findByIdAndUpdate(socket.userId, { isOnline: false, lastSeen: new Date() });
        io.emit('user:status', { userId: socket.userId, isOnline: false, lastSeen: new Date() });
      }
    });
  });

  // Helper: push notification to a user if online
  io.notifyUser = (userId, event, data) => {
    const ts = onlineUsers.get(userId?.toString());
    if (ts) io.to(ts).emit(event, data);
  };
};
