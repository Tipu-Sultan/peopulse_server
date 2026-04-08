const express = require('express');
const router  = express.Router();
const Notification = require('../models/Notification');
const auth    = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try {
    const { page=1, limit=20 } = req.query;
    const notifs = await Notification.find({ recipient: req.userId })
      .sort({ createdAt: -1 }).skip((page-1)*limit).limit(+limit)
      .populate('sender', 'username fullName avatar isVerified')
      .populate('post', 'media caption type')
      .populate('reel', 'thumbnail caption');
    res.json(notifs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/read', auth, async (req, res) => {
  try {
    await Notification.updateMany({ recipient: req.userId, isRead: false }, { isRead: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/read/:id', auth, async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.id, { isRead: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/unread-count', auth, async (req, res) => {
  try {
    const count = await Notification.countDocuments({ recipient: req.userId, isRead: false });
    res.json({ count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
