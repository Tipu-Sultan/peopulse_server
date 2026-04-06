const express = require('express');
const router = express.Router();
const { Message, Conversation } = require('../models/Chat');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// Get or create direct conversation
router.post('/conversation/direct', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    let conv = await Conversation.findOne({
      type: 'direct',
      participants: { $all: [req.userId, userId] }
    }).populate('participants', 'username fullName avatar isVerified isOnline lastSeen')
      .populate('lastMessage');

    if (!conv) {
      conv = await Conversation.create({
        type: 'direct',
        participants: [req.userId, userId]
      });
      await conv.populate('participants', 'username fullName avatar isVerified isOnline lastSeen');
    }
    res.json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create group
router.post('/conversation/group', auth, async (req, res) => {
  try {
    const { name, participants, avatar, description } = req.body;
    const allParticipants = [...new Set([...participants, req.userId.toString()])];

    const conv = await Conversation.create({
      type: 'group',
      name,
      participants: allParticipants,
      admins: [req.userId],
      createdBy: req.userId,
      avatar: avatar || '',
      description: description || '',
      joinLink: uuidv4(),
    });

    await conv.populate('participants', 'username fullName avatar isVerified isOnline');
    await conv.populate('admins', 'username fullName avatar');
    res.status(201).json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all conversations
router.get('/conversations', auth, async (req, res) => {
  try {
    const convs = await Conversation.find({
      participants: req.userId,
      deletedBy: { $not: { $elemMatch: { user: req.userId } } }
    })
      .populate('participants', 'username fullName avatar isVerified isOnline lastSeen')
      .populate('admins', 'username fullName avatar')
      .populate({ path: 'lastMessage', populate: { path: 'sender', select: 'username fullName avatar' } })
      .sort({ lastActivity: -1 });

    // Filter out blocked users for direct chats
    const currentUser = await User.findById(req.userId);
    const filtered = convs.filter(c => {
      if (c.type === 'direct') {
        const other = c.participants.find(p => p._id.toString() !== req.userId.toString());
        return !currentUser.blockedUsers.includes(other?._id);
      }
      return true;
    });

    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get messages
router.get('/messages/:conversationId', auth, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const messages = await Message.find({
      conversation: req.params.conversationId,
      deletedFor: { $ne: req.userId },
      deletedForEveryone: false
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('sender', 'username fullName avatar isVerified')
      .populate('replyTo');

    res.json(messages.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send message
router.post('/messages', auth, async (req, res) => {
  try {
    const { conversationId, content, type, media, replyTo } = req.body;

    const conv = await Conversation.findById(conversationId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!conv.participants.includes(req.userId)) return res.status(403).json({ error: 'Not a participant' });

    // Check group permission
    if (conv.type === 'group' && conv.onlyAdminsCanMessage && !conv.admins.includes(req.userId))
      return res.status(403).json({ error: 'Only admins can send messages' });

    const message = await Message.create({
      conversation: conversationId,
      sender: req.userId,
      content: content || '',
      type: type || 'text',
      media: media || [],
      replyTo,
    });

    await message.populate('sender', 'username fullName avatar isVerified');
    if (replyTo) await message.populate('replyTo');

    conv.lastMessage = message._id;
    conv.lastActivity = new Date();
    await conv.save();

    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit message (within 5 minutes)
router.put('/messages/:id', auth, async (req, res) => {
  try {
    const { content } = req.body;
    const message = await Message.findById(req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.sender.toString() !== req.userId.toString()) return res.status(403).json({ error: 'Not authorized' });

    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() - message.createdAt.getTime() > fiveMinutes)
      return res.status(400).json({ error: 'Edit window expired (5 minutes)' });

    message.editHistory.push({ content: message.content, editedAt: new Date() });
    message.content = content;
    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete message (for me or for everyone)
router.delete('/messages/:id', auth, async (req, res) => {
  try {
    const { deleteForEveryone } = req.body;
    const message = await Message.findById(req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    if (deleteForEveryone && message.sender.toString() === req.userId.toString()) {
      message.deletedForEveryone = true;
      message.content = 'This message was deleted';
      message.media = [];
    } else {
      if (!message.deletedFor.includes(req.userId))
        message.deletedFor.push(req.userId);
    }
    await message.save();
    res.json({ message: 'Deleted', deleteForEveryone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk delete messages
router.delete('/messages/bulk/delete', auth, async (req, res) => {
  try {
    const { messageIds, deleteForEveryone } = req.body;
    if (deleteForEveryone) {
      await Message.updateMany(
        { _id: { $in: messageIds }, sender: req.userId },
        { deletedForEveryone: true, content: 'This message was deleted', media: [] }
      );
    } else {
      await Message.updateMany(
        { _id: { $in: messageIds } },
        { $addToSet: { deletedFor: req.userId } }
      );
    }
    res.json({ message: 'Bulk deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add reaction
router.post('/messages/:id/react', auth, async (req, res) => {
  try {
    const { emoji } = req.body;
    const message = await Message.findById(req.params.id);
    const existing = message.reactions.find(r => r.user.toString() === req.userId.toString());

    if (existing) {
      if (existing.emoji === emoji) message.reactions.pull(existing);
      else existing.emoji = emoji;
    } else {
      message.reactions.push({ user: req.userId, emoji });
    }
    await message.save();
    res.json(message.reactions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update group settings
router.put('/conversation/:id/settings', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv.admins.includes(req.userId)) return res.status(403).json({ error: 'Admin only' });

    const { name, description, avatar, onlyAdminsCanMessage, onlyAdminsCanEditInfo } = req.body;
    Object.assign(conv, { name, description, avatar, onlyAdminsCanMessage, onlyAdminsCanEditInfo });
    await conv.save();
    res.json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add members to group
router.post('/conversation/:id/members', auth, async (req, res) => {
  try {
    const { userIds } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv.admins.includes(req.userId)) return res.status(403).json({ error: 'Admin only' });

    const newMembers = userIds.filter(id => !conv.participants.includes(id));
    conv.participants.push(...newMembers);
    await conv.save();
    await conv.populate('participants', 'username fullName avatar isVerified');
    res.json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove member from group
router.delete('/conversation/:id/members/:userId', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv.admins.includes(req.userId)) return res.status(403).json({ error: 'Admin only' });

    conv.participants.pull(req.params.userId);
    conv.admins.pull(req.params.userId);
    await conv.save();
    res.json({ message: 'Member removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Make/remove admin
router.post('/conversation/:id/admins/:userId', auth, async (req, res) => {
  try {
    const { action } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv.admins.includes(req.userId)) return res.status(403).json({ error: 'Admin only' });

    if (action === 'add') conv.admins.push(req.params.userId);
    else conv.admins.pull(req.params.userId);
    await conv.save();
    res.json({ message: `Admin ${action}ed` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leave group
router.post('/conversation/:id/leave', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    conv.participants.pull(req.userId);
    conv.admins.pull(req.userId);

    // If no admins left, make first participant admin
    if (conv.admins.length === 0 && conv.participants.length > 0)
      conv.admins.push(conv.participants[0]);

    await conv.save();
    res.json({ message: 'Left group' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete conversation (only for me)
router.delete('/conversation/:id', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv.deletedBy.some(d => d.user.toString() === req.userId.toString()))
      conv.deletedBy.push({ user: req.userId, deletedAt: new Date() });
    await conv.save();
    res.json({ message: 'Conversation deleted for you' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pin/unpin message
router.post('/conversation/:id/pin/:messageId', auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv.admins.includes(req.userId) && conv.type === 'group') return res.status(403).json({ error: 'Admin only' });

    const isPinned = conv.pinnedMessages.includes(req.params.messageId);
    if (isPinned) conv.pinnedMessages.pull(req.params.messageId);
    else conv.pinnedMessages.push(req.params.messageId);
    await conv.save();
    res.json({ pinned: !isPinned });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark as read
router.post('/messages/read/:conversationId', auth, async (req, res) => {
  try {
    await Message.updateMany(
      { conversation: req.params.conversationId, 'readBy.user': { $ne: req.userId } },
      { $push: { readBy: { user: req.userId, readAt: new Date() } } }
    );
    res.json({ message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate Ably token for calling
router.get('/call-token', auth, async (req, res) => {
  try {
    const Ably = require('ably');
    const client = new Ably.Rest(process.env.NEXT_PUBLIC_ABLY_API_KEY);
    const tokenParams = { clientId: req.userId.toString() };
    client.auth.createTokenRequest(tokenParams, (err, tokenRequest) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(tokenRequest);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
