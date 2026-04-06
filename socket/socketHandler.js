const User = require('../models/User');
const { Message, Conversation } = require('../models/Chat');
const Notification = require('../models/Notification');

module.exports = (io) => {
  const onlineUsers = new Map(); // userId -> socketId

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // User comes online
    socket.on('user:online', async (userId) => {
      if (!userId) return;
      onlineUsers.set(userId, socket.id);
      socket.userId = userId;
      await User.findByIdAndUpdate(userId, { isOnline: true, socketId: socket.id, lastSeen: new Date() });
      io.emit('user:status', { userId, isOnline: true });
    });

    // Join conversation rooms
    socket.on('conversation:join', (conversationId) => {
      socket.join(conversationId);
    });

    socket.on('conversation:leave', (conversationId) => {
      socket.leave(conversationId);
    });

    // New message
    socket.on('message:send', async (data) => {
      const { conversationId, message } = data;
      io.to(conversationId).emit('message:new', message);

      // Notify offline participants
      const conv = await Conversation.findById(conversationId).populate('participants', '_id socketId');
      conv.participants.forEach(p => {
        if (p._id.toString() !== socket.userId && !onlineUsers.has(p._id.toString())) {
          // Could send push notification here
        }
      });
    });

    // Message edited
    socket.on('message:edit', (data) => {
      io.to(data.conversationId).emit('message:edited', data);
    });

    // Message deleted
    socket.on('message:delete', (data) => {
      io.to(data.conversationId).emit('message:deleted', data);
    });

    // Typing indicator
    socket.on('typing:start', (data) => {
      socket.to(data.conversationId).emit('typing:started', { userId: socket.userId, conversationId: data.conversationId });
    });

    socket.on('typing:stop', (data) => {
      socket.to(data.conversationId).emit('typing:stopped', { userId: socket.userId, conversationId: data.conversationId });
    });

    // Message read
    socket.on('message:read', (data) => {
      socket.to(data.conversationId).emit('message:seen', { userId: socket.userId, conversationId: data.conversationId });
    });

    // Reactions
    socket.on('message:react', (data) => {
      io.to(data.conversationId).emit('message:reacted', data);
    });

    // === CALLING (Ably-based signaling via socket for setup) ===
    socket.on('call:initiate', (data) => {
      const { targetUserId, callType, conversationId, callerInfo } = data;
      const targetSocket = onlineUsers.get(targetUserId);
      if (targetSocket) {
        io.to(targetSocket).emit('call:incoming', {
          callType,
          conversationId,
          callerInfo,
          callerId: socket.userId,
        });
      }
    });

    socket.on('call:accept', (data) => {
      const callerSocket = onlineUsers.get(data.callerId);
      if (callerSocket) io.to(callerSocket).emit('call:accepted', { ...data, accepterId: socket.userId });
    });

    socket.on('call:reject', (data) => {
      const callerSocket = onlineUsers.get(data.callerId);
      if (callerSocket) io.to(callerSocket).emit('call:rejected', { callerId: data.callerId });
    });

    socket.on('call:end', (data) => {
      const { targetUserId } = data;
      const targetSocket = onlineUsers.get(targetUserId);
      if (targetSocket) io.to(targetSocket).emit('call:ended', { endedBy: socket.userId });
    });

    // WebRTC signal relay
    socket.on('call:signal', (data) => {
      const targetSocket = onlineUsers.get(data.targetUserId);
      if (targetSocket) io.to(targetSocket).emit('call:signal', { signal: data.signal, from: socket.userId });
    });

    // Group calls
    socket.on('call:group:join', (data) => {
      socket.join(`call:${data.conversationId}`);
      socket.to(`call:${data.conversationId}`).emit('call:group:user-joined', { userId: socket.userId });
    });

    socket.on('call:group:leave', (data) => {
      socket.leave(`call:${data.conversationId}`);
      socket.to(`call:${data.conversationId}`).emit('call:group:user-left', { userId: socket.userId });
    });

    // Notification delivery
    socket.on('notification:send', async (data) => {
      const targetSocket = onlineUsers.get(data.recipientId);
      if (targetSocket) io.to(targetSocket).emit('notification:new', data.notification);
    });

    // Live post interactions
    socket.on('post:liked', (data) => {
      io.emit('post:like:update', data);
    });

    // Story view
    socket.on('story:viewed', (data) => {
      const ownerSocket = onlineUsers.get(data.authorId);
      if (ownerSocket) io.to(ownerSocket).emit('story:view:new', data);
    });

    // Disconnect
    socket.on('disconnect', async () => {
      if (socket.userId) {
        onlineUsers.delete(socket.userId);
        await User.findByIdAndUpdate(socket.userId, { isOnline: false, lastSeen: new Date() });
        io.emit('user:status', { userId: socket.userId, isOnline: false, lastSeen: new Date() });
      }
    });
  });
};
