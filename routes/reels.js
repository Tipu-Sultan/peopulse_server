const express = require('express');
const router  = express.Router();
const Reel    = require('../models/Reel');
const User    = require('../models/User');
const Notification = require('../models/Notification');
const auth    = require('../middleware/auth');

router.post('/', auth, async (req, res) => {
  try {
    const { videoUrl, publicId, thumbnail, caption, audio, tags, duration } = req.body;
    const reel = new Reel({ author: req.userId, videoUrl, publicId, thumbnail, caption, audio, tags, duration });
    await reel.save();
    await reel.populate('author', 'username fullName avatar isVerified');
    res.status(201).json(reel);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/feed', auth, async (req, res) => {
  try {
    const { page=1, limit=10 } = req.query;
    const me = await User.findById(req.userId);
    const reels = await Reel.find({ author: { $nin: me.blockedUsers }, isPublic: true })
      .sort({ createdAt: -1 }).skip((page-1)*limit).limit(+limit)
      .populate('author', 'username fullName avatar isVerified');
    res.json(reels);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/user/:userId', auth, async (req, res) => {
  try {
    const reels = await Reel.find({ author: req.params.userId, isPublic: true })
      .sort({ createdAt: -1 }).populate('author', 'username fullName avatar isVerified');
    res.json(reels);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/like', auth, async (req, res) => {
  try {
    const io   = req.app.get('io');
    const reel = await Reel.findById(req.params.id);
    if (!reel) return res.status(404).json({ error: 'Not found' });
    const liked = reel.likes.includes(req.userId);
    if (liked) reel.likes.pull(req.userId);
    else {
      reel.likes.push(req.userId);
      if (reel.author.toString() !== req.userId.toString()) {
        const notif = await Notification.create({ recipient: reel.author, sender: req.userId, type: 'reel_like', reel: reel._id });
        await notif.populate('sender', 'username fullName avatar');
        io?.notifyUser(reel.author.toString(), 'notification:new', notif);
      }
    }
    await reel.save();
    io?.emit('reel:like:update', { reelId: reel._id, likesCount: reel.likes.length, userId: req.userId, liked: !liked });
    res.json({ liked: !liked, likesCount: reel.likes.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/comment', auth, async (req, res) => {
  try {
    const io   = req.app.get('io');
    const { text } = req.body;
    const reel = await Reel.findById(req.params.id);
    reel.comments.push({ user: req.userId, text });
    await reel.save();
    await Reel.populate(reel, { path: 'comments.user', select: 'username fullName avatar isVerified' });
    if (reel.author.toString() !== req.userId.toString()) {
      const notif = await Notification.create({ recipient: reel.author, sender: req.userId, type: 'reel_comment', reel: reel._id, message: text });
      await notif.populate('sender', 'username fullName avatar');
      io?.notifyUser(reel.author.toString(), 'notification:new', notif);
    }
    res.json(reel.comments[reel.comments.length - 1]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/view', auth, async (req, res) => {
  try {
    await Reel.findByIdAndUpdate(req.params.id, { $addToSet: { views: req.userId } });
    res.json({ viewed: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete reel + Cloudinary
router.delete('/:id', auth, async (req, res) => {
  try {
    const cloudinary = req.app.get('cloudinary');
    const reel = await Reel.findOneAndDelete({ _id: req.params.id, author: req.userId });
    if (!reel) return res.status(404).json({ error: 'Not found' });
    if (reel.publicId) {
      await cloudinary.uploader.destroy(reel.publicId, { resource_type: 'video' }).catch(() => {});
    }
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
