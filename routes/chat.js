const express = require('express');
const router  = express.Router();
const { Message, Conversation } = require('../models/Chat');
const User    = require('../models/User');
const auth    = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// Get or create direct conversation
router.post('/conversation/direct', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    let conv = await Conversation.findOne({ type:'direct', participants: { $all: [req.userId, userId] } })
      .populate('participants', 'username fullName avatar isVerified isOnline lastSeen')
      .populate({ path: 'lastMessage', populate: { path: 'sender', select: 'username fullName avatar' } });
    if (!conv) {
      conv = await Conversation.create({ type: 'direct', participants: [req.userId, userId] });
      await conv.populate('participants', 'username fullName avatar isVerified isOnline lastSeen');
    }
    res.json(conv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create group
router.post('/conversation/group', auth, async (req, res) => {
  try {
    const { name, participants, avatar, description } = req.body;
    const all = [...new Set([...participants, req.userId.toString()])];
    const conv = await Conversation.create({
      type: 'group', name, participants: all, admins: [req.userId],
      createdBy: req.userId, avatar: avatar||'', description: description||'', joinLink: uuidv4(),
    });
    await conv.populate('participants', 'username fullName avatar isVerified isOnline');
    await conv.populate('admins', 'username fullName avatar');
    res.status(201).json(conv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// All conversations
router.get('/conversations', auth, async (req, res) => {
  try {
    const convs = await Conversation.find({
      participants: req.userId,
      'deletedBy.user': { $ne: req.userId }
    }).populate('participants', 'username fullName avatar isVerified isOnline lastSeen')
      .populate('admins', 'username fullName avatar')
      .populate({ path: 'lastMessage', populate: { path: 'sender', select: 'username fullName avatar' } })
      .sort({ lastActivity: -1 });

    const me = await User.findById(req.userId);
    const filtered = convs.filter(c => {
      if (c.type === 'direct') {
        const other = c.participants.find(p => p._id.toString() !== req.userId.toString());
        return !me.blockedUsers.some(b => b.toString() === other?._id?.toString());
      }
      return true;
    });

    // Attach unread counts
    const withCounts = await Promise.all(filtered.map(async (c) => {
      const unread = await Message.countDocuments({
        conversation: c._id,
        'readBy.user': { $ne: req.userId },
        sender: { $ne: req.userId },
        deletedForEveryone: false,
        'deletedFor': { $ne: req.userId }
      });
      return { ...c.toObject(), unreadCount: unread };
    }));

    res.json(withCounts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Messages
router.get('/messages/:conversationId', auth, async (req, res) => {
  try {
    const { page=1, limit=30 } = req.query;
    const msgs = await Message.find({
      conversation: req.params.conversationId,
      deletedFor: { $ne: req.userId },
      deletedForEveryone: false
    }).sort({ createdAt: -1 }).skip((page-1)*limit).limit(+limit)
      .populate('sender', 'username fullName avatar isVerified')
      .populate({ path: 'replyTo', populate: { path: 'sender', select: 'username fullName avatar' } });
    res.json(msgs.reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send message
router.post('/messages', auth, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { conversationId, content, type, media, replyTo } = req.body;
    const conv = await Conversation.findById(conversationId);
    if (!conv || !conv.participants.includes(req.userId))
      return res.status(403).json({ error: 'Not a participant' });
    if (conv.type==='group' && conv.onlyAdminsCanMessage && !conv.admins.includes(req.userId))
      return res.status(403).json({ error: 'Only admins can send messages' });

    const msg = await Message.create({
      conversation: conversationId, sender: req.userId,
      content: content||'', type: type||'text', media: media||[], replyTo
    });
    await msg.populate('sender', 'username fullName avatar isVerified');
    if (replyTo) await msg.populate({ path: 'replyTo', populate: { path: 'sender', select: 'username fullName avatar' } });

    conv.lastMessage = msg._id; conv.lastActivity = new Date();
    await conv.save();

    // Push to all in room + unread to offline
    io?.to(conversationId).emit('message:new', msg);
    conv.participants.forEach(pid => {
      if (pid.toString() !== req.userId.toString()) {
        io?.notifyUser(pid.toString(), 'chat:unread:increment', { conversationId });
      }
    });

    res.status(201).json(msg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit message (5 min window)
router.put('/messages/:id', auth, async (req, res) => {
  try {
    const io  = req.app.get('io');
    const { content } = req.body;
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.sender.toString() !== req.userId.toString()) return res.status(403).json({ error: 'Not authorized' });
    if (Date.now() - msg.createdAt.getTime() > 5*60*1000)
      return res.status(400).json({ error: 'Edit window expired (5 minutes)' });

    msg.editHistory.push({ content: msg.content, editedAt: new Date() });
    msg.content = content; msg.isEdited = true; msg.editedAt = new Date();
    await msg.save();
    io?.to(msg.conversation.toString()).emit('message:edited', { conversationId: msg.conversation, message: msg });
    res.json(msg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete message
router.delete('/messages/:id', auth, async (req, res) => {
  try {
    const io  = req.app.get('io');
    const { deleteForEveryone } = req.body;
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });

    // Delete media from cloudinary
    if (deleteForEveryone && msg.sender.toString() === req.userId.toString()) {
      const cloudinary = req.app.get('cloudinary');
      if (msg.media?.length) {
        await Promise.all(msg.media.filter(m => m.publicId).map(m =>
          cloudinary.uploader.destroy(m.publicId, { resource_type: m.type==='video' ? 'video' : 'image' }).catch(() => {})
        ));
      }
      msg.deletedForEveryone = true; msg.content = ''; msg.media = [];
    } else {
      if (!msg.deletedFor.includes(req.userId)) msg.deletedFor.push(req.userId);
    }
    await msg.save();
    io?.to(msg.conversation.toString()).emit('message:deleted', {
      conversationId: msg.conversation, messageId: msg._id, deleteForEveryone
    });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk delete
router.delete('/messages/bulk/delete', auth, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { messageIds, deleteForEveryone, conversationId } = req.body;
    if (deleteForEveryone) {
      await Message.updateMany({ _id: { $in: messageIds }, sender: req.userId },
        { deletedForEveryone: true, content: '', media: [] });
    } else {
      await Message.updateMany({ _id: { $in: messageIds } }, { $addToSet: { deletedFor: req.userId } });
    }
    io?.to(conversationId).emit('messages:bulk:deleted', { messageIds, deleteForEveryone });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// React to message
router.post('/messages/:id/react', auth, async (req, res) => {
  try {
    const io  = req.app.get('io');
    const { emoji } = req.body;
    const msg = await Message.findById(req.params.id);
    const existing = msg.reactions.find(r => r.user.toString() === req.userId.toString());
    if (existing) {
      if (existing.emoji === emoji) msg.reactions.pull(existing);
      else existing.emoji = emoji;
    } else {
      msg.reactions.push({ user: req.userId, emoji });
    }
    await msg.save();
    io?.to(msg.conversation.toString()).emit('message:reacted', {
      conversationId: msg.conversation, messageId: msg._id, reactions: msg.reactions
    });
    res.json(msg.reactions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Group settings
router.put('/conversation/:id/settings', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv.admins.some(a => a.toString() === req.userId.toString()))
      return res.status(403).json({ error: 'Admin only' });
    const { name, description, avatar, onlyAdminsCanMessage, onlyAdminsCanEditInfo,
            allowMemberInvite, messageDisappearAfter, approveNewMembers } = req.body;
    Object.assign(conv, { name, description, avatar, onlyAdminsCanMessage, onlyAdminsCanEditInfo,
      allowMemberInvite, messageDisappearAfter, approveNewMembers });
    await conv.save();
    const io = req.app.get('io');
    io?.to(conv._id.toString()).emit('group:updated', conv);
    res.json(conv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add members
router.post('/conversation/:id/members', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv.admins.some(a => a.toString() === req.userId.toString()))
      return res.status(403).json({ error: 'Admin only' });
    const { userIds } = req.body;
    const newMembers = userIds.filter(id => !conv.participants.some(p => p.toString() === id));
    conv.participants.push(...newMembers);
    await conv.save();
    await conv.populate('participants', 'username fullName avatar isVerified');
    const io = req.app.get('io');
    io?.to(conv._id.toString()).emit('group:members:updated', { participants: conv.participants });
    res.json(conv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove member
router.delete('/conversation/:id/members/:userId', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv.admins.some(a => a.toString() === req.userId.toString()))
      return res.status(403).json({ error: 'Admin only' });
    conv.participants.pull(req.params.userId);
    conv.admins.pull(req.params.userId);
    await conv.save();
    const io = req.app.get('io');
    io?.to(conv._id.toString()).emit('group:member:removed', { userId: req.params.userId });
    res.json({ message: 'Removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toggle admin
router.post('/conversation/:id/admins/:userId', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv.admins.some(a => a.toString() === req.userId.toString()))
      return res.status(403).json({ error: 'Admin only' });
    const { action } = req.body; // 'add' | 'remove'
    if (action === 'add') conv.admins.push(req.params.userId);
    else conv.admins.pull(req.params.userId);
    await conv.save();
    const io = req.app.get('io');
    io?.to(conv._id.toString()).emit('group:admin:changed', { userId: req.params.userId, action });
    res.json({ message: `Admin ${action}ed` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Leave group
router.post('/conversation/:id/leave', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    conv.participants.pull(req.userId);
    conv.admins.pull(req.userId);
    if (conv.admins.length === 0 && conv.participants.length > 0) conv.admins.push(conv.participants[0]);
    await conv.save();
    const io = req.app.get('io');
    io?.to(conv._id.toString()).emit('group:member:left', { userId: req.userId });
    res.json({ message: 'Left' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete conversation (for me)
router.delete('/conversation/:id', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv.deletedBy.some(d => d.user.toString() === req.userId.toString()))
      conv.deletedBy.push({ user: req.userId, deletedAt: new Date() });
    await conv.save();
    res.json({ message: 'Deleted for you' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pin message
router.post('/conversation/:id/pin/:msgId', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    const isPinned = conv.pinnedMessages.includes(req.params.msgId);
    if (isPinned) conv.pinnedMessages.pull(req.params.msgId);
    else conv.pinnedMessages.push(req.params.msgId);
    await conv.save();
    res.json({ pinned: !isPinned });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark as read
router.post('/messages/read/:conversationId', auth, async (req, res) => {
  try {
    await Message.updateMany(
      { conversation: req.params.conversationId, 'readBy.user': { $ne: req.userId } },
      { $push: { readBy: { user: req.userId, readAt: new Date() } } }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
