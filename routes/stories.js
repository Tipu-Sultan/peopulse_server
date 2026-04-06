const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const auth = require('../middleware/auth');

// Already handled in posts.js - this adds extra story-specific endpoints

// Get my story viewers
router.get('/:id/viewers', auth, async (req, res) => {
  try {
    const story = await Post.findOne({ _id: req.params.id, author: req.userId, type: 'story' })
      .populate('storyViewers.user', 'username fullName avatar isVerified');
    if (!story) return res.status(404).json({ error: 'Story not found' });
    res.json(story.storyViewers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reply to story (sends as DM)
router.post('/:id/reply', auth, async (req, res) => {
  try {
    const { text } = req.body;
    const story = await Post.findById(req.params.id).populate('author');
    if (!story) return res.status(404).json({ error: 'Story not found' });

    const { Conversation, Message } = require('../models/Chat');
    let conv = await Conversation.findOne({ type: 'direct', participants: { $all: [req.userId, story.author._id] } });
    if (!conv) conv = await Conversation.create({ type: 'direct', participants: [req.userId, story.author._id] });

    const message = await Message.create({
      conversation: conv._id,
      sender: req.userId,
      type: 'text',
      content: `Replied to your story: "${text}"`,
    });

    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
