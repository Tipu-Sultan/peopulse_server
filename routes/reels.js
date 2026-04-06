const express = require('express');
const router = express.Router();
const Reel = require('../models/Reel');
const User = require('../models/User');
const Notification = require('../models/Notification');
const auth = require('../middleware/auth');

// Create reel
router.post('/', auth, async (req, res) => {
  try {
    const { videoUrl, publicId, thumbnail, caption, audio, tags, duration } = req.body;
    const reel = new Reel({ author: req.userId, videoUrl, publicId, thumbnail, caption, audio, tags, duration });
    await reel.save();
    await reel.populate('author', 'username fullName avatar isVerified');
    res.status(201).json(reel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get reels feed
router.get('/feed', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const currentUser = await User.findById(req.userId);

    const reels = await Reel.find({
      author: { $nin: currentUser.blockedUsers },
      isPublic: true
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('author', 'username fullName avatar isVerified');

    res.json(reels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user reels
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const reels = await Reel.find({ author: req.params.userId, isPublic: true })
      .sort({ createdAt: -1 })
      .populate('author', 'username fullName avatar isVerified');
    res.json(reels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Like reel
router.post('/:id/like', auth, async (req, res) => {
  try {
    const reel = await Reel.findById(req.params.id);
    if (!reel) return res.status(404).json({ error: 'Reel not found' });

    const hasLiked = reel.likes.includes(req.userId);
    if (hasLiked) reel.likes.pull(req.userId);
    else {
      reel.likes.push(req.userId);
      if (reel.author.toString() !== req.userId.toString())
        await Notification.create({ recipient: reel.author, sender: req.userId, type: 'reel_like', reel: reel._id });
    }
    await reel.save();
    res.json({ liked: !hasLiked, likesCount: reel.likes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Comment on reel
router.post('/:id/comment', auth, async (req, res) => {
  try {
    const { text } = req.body;
    const reel = await Reel.findById(req.params.id);
    reel.comments.push({ user: req.userId, text });
    await reel.save();

    if (reel.author.toString() !== req.userId.toString())
      await Notification.create({ recipient: reel.author, sender: req.userId, type: 'reel_comment', reel: reel._id, message: text });

    await Reel.populate(reel, { path: 'comments.user', select: 'username fullName avatar isVerified' });
    res.json(reel.comments[reel.comments.length - 1]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// View reel
router.post('/:id/view', auth, async (req, res) => {
  try {
    await Reel.findByIdAndUpdate(req.params.id, { $addToSet: { views: req.userId } });
    res.json({ viewed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete reel
router.delete('/:id', auth, async (req, res) => {
  try {
    const reel = await Reel.findOneAndDelete({ _id: req.params.id, author: req.userId });
    if (!reel) return res.status(404).json({ error: 'Not found or not authorized' });
    res.json({ message: 'Reel deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
