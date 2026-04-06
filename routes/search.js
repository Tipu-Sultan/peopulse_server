const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Post = require('../models/Post');
const Reel = require('../models/Reel');
const auth = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try {
    const { q, type = 'all', page = 1, limit = 20 } = req.query;
    if (!q) return res.json({ users: [], posts: [], reels: [], tags: [] });

    const regex = new RegExp(q, 'i');
    const currentUser = await User.findById(req.userId);
    const results = {};

    if (type === 'all' || type === 'users') {
      results.users = await User.find({
        $or: [{ username: regex }, { fullName: regex }],
        _id: { $nin: [...currentUser.blockedUsers, req.userId] }
      }).select('username fullName avatar isVerified isOnline').limit(parseInt(limit));
    }

    if (type === 'all' || type === 'posts') {
      results.posts = await Post.find({
        $or: [{ caption: regex }, { tags: regex }],
        type: { $in: ['post', 'text'] },
        isArchived: false
      }).populate('author', 'username fullName avatar isVerified').limit(parseInt(limit));
    }

    if (type === 'all' || type === 'reels') {
      results.reels = await Reel.find({ $or: [{ caption: regex }, { tags: regex }] })
        .populate('author', 'username fullName avatar isVerified').limit(parseInt(limit));
    }

    if (type === 'all' || type === 'tags') {
      const tags = await Post.distinct('tags', { tags: regex });
      results.tags = tags.slice(0, 20);
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trending tags
router.get('/trending', auth, async (req, res) => {
  try {
    const tags = await Post.aggregate([
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]);
    res.json(tags);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
