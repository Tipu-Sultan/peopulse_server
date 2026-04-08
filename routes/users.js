const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Post = require('../models/Post');
const Reel = require('../models/Reel');
const Notification = require('../models/Notification');
const auth = require('../middleware/auth');

// Get user profile
router.get('/:username', auth, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username })
      .populate('followers', 'username fullName avatar isVerified')
      .populate('following', 'username fullName avatar isVerified')
      .select('-password -socketId');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const currentUser = await User.findById(req.userId).select('blockedUsers');
    const isBlocked = user.blockedUsers.includes(req.userId) || currentUser.blockedUsers.includes(user._id);
    if (isBlocked) return res.status(403).json({ error: 'Blocked' });

    const isFollowing = user.followers.some(f => f._id.toString() === req.userId.toString());
    const isPending   = user.followRequests.includes(req.userId);
    const isMe        = user._id.toString() === req.userId.toString();

    const postsCount = await Post.countDocuments({ author: user._id, type: { $in: ['post','text'] }, isArchived: false });
    const reelsCount = await Reel.countDocuments({ author: user._id });

    res.json({ ...user.toPublicJSON(), isFollowing, isPending, isMe, postsCount, reelsCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update profile
router.put('/profile/update', auth, async (req, res) => {
  try {
    const { fullName, bio, website, links, isPrivate, location, profession, gender, dateOfBirth } = req.body;
    const user = await User.findByIdAndUpdate(req.userId,
      { fullName, bio, website, links, isPrivate, location, profession, gender, dateOfBirth },
      { new: true, runValidators: true }
    ).select('-password');
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update avatar (with Cloudinary delete)
router.put('/profile/avatar', auth, async (req, res) => {
  try {
    const { avatar, oldPublicId } = req.body;
    if (oldPublicId) {
      const cloudinary = req.app.get('cloudinary');
      await cloudinary.uploader.destroy(oldPublicId).catch(() => {});
    }
    const user = await User.findByIdAndUpdate(req.userId, { avatar }, { new: true }).select('-password');
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update cover (with Cloudinary delete)
router.put('/profile/cover', auth, async (req, res) => {
  try {
    const { coverPhoto, oldPublicId } = req.body;
    if (oldPublicId) {
      const cloudinary = req.app.get('cloudinary');
      await cloudinary.uploader.destroy(oldPublicId).catch(() => {});
    }
    const user = await User.findByIdAndUpdate(req.userId, { coverPhoto }, { new: true }).select('-password');
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Follow / Unfollow
router.post('/:userId/follow', auth, async (req, res) => {
  try {
    const io = req.app.get('io');
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (targetUser._id.toString() === req.userId.toString()) return res.status(400).json({ error: 'Cannot follow yourself' });

    const isFollowing = targetUser.followers.includes(req.userId);
    const isPending   = targetUser.followRequests.includes(req.userId);

    if (isFollowing) {
      await User.findByIdAndUpdate(targetUser._id, { $pull: { followers: req.userId } });
      await User.findByIdAndUpdate(req.userId, { $pull: { following: targetUser._id } });
      return res.json({ message: 'Unfollowed', isFollowing: false, isPending: false });
    }

    if (isPending) {
      // Cancel follow request
      await User.findByIdAndUpdate(targetUser._id, { $pull: { followRequests: req.userId } });
      return res.json({ message: 'Request cancelled', isFollowing: false, isPending: false });
    }

    if (targetUser.isPrivate) {
      await User.findByIdAndUpdate(targetUser._id, { $push: { followRequests: req.userId } });
      const requester = await User.findById(req.userId).select('username fullName avatar');
      const notif = await Notification.create({ recipient: targetUser._id, sender: req.userId, type: 'follow_request' });
      await notif.populate('sender', 'username fullName avatar');

      // Real-time: show request to target + increment badge
      io?.notifyUser(targetUser._id.toString(), 'notification:new', notif);
      io?.notifyUser(targetUser._id.toString(), 'follow:request', {
        from: requester, userId: req.userId
      });
      return res.json({ message: 'Follow request sent', isFollowing: false, isPending: true });
    }

    await User.findByIdAndUpdate(targetUser._id, { $push: { followers: req.userId } });
    await User.findByIdAndUpdate(req.userId,      { $push: { following: targetUser._id } });
    const notif = await Notification.create({ recipient: targetUser._id, sender: req.userId, type: 'follow' });
    await notif.populate('sender', 'username fullName avatar');
    io?.notifyUser(targetUser._id.toString(), 'notification:new', notif);
    res.json({ message: 'Followed', isFollowing: true, isPending: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Accept / Reject follow request
router.post('/follow-request/:userId/:action', auth, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { userId, action } = req.params;
    await User.findByIdAndUpdate(req.userId, { $pull: { followRequests: userId } });
    if (action === 'accept') {
      await User.findByIdAndUpdate(req.userId, { $push: { followers: userId } });
      await User.findByIdAndUpdate(userId,     { $push: { following: req.userId } });
      const notif = await Notification.create({ recipient: userId, sender: req.userId, type: 'follow_accepted' });
      await notif.populate('sender', 'username fullName avatar');
      io?.notifyUser(userId, 'notification:new', notif);
      io?.notifyUser(userId, 'follow:accepted', { by: req.userId });
    }
    res.json({ message: `Request ${action}ed` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Block / Unblock
router.post('/:userId/block', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const isBlocked = user.blockedUsers.includes(req.params.userId);
    if (isBlocked) {
      await User.findByIdAndUpdate(req.userId, { $pull: { blockedUsers: req.params.userId } });
      return res.json({ isBlocked: false });
    }
    await User.findByIdAndUpdate(req.userId, {
      $push: { blockedUsers: req.params.userId },
      $pull: { followers: req.params.userId, following: req.params.userId }
    });
    await User.findByIdAndUpdate(req.params.userId, { $pull: { followers: req.userId, following: req.userId } });
    res.json({ isBlocked: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:userId/followers', auth, async (req, res) => {
  try {
    const u = await User.findById(req.params.userId).populate('followers', 'username fullName avatar isVerified isOnline');
    res.json(u.followers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:userId/following', auth, async (req, res) => {
  try {
    const u = await User.findById(req.params.userId).populate('following', 'username fullName avatar isVerified isOnline');
    res.json(u.following);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/suggestions/list', auth, async (req, res) => {
  try {
    const me = await User.findById(req.userId);
    const users = await User.find({
      _id: { $nin: [...me.following, ...me.blockedUsers, req.userId] },
      isPrivate: false
    }).select('username fullName avatar isVerified').limit(20);
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/followers/:userId', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId,        { $pull: { followers: req.params.userId } });
    await User.findByIdAndUpdate(req.params.userId, { $pull: { following: req.userId } });
    res.json({ message: 'Removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get follow requests
router.get('/follow-requests/list', auth, async (req, res) => {
  try {
    const me = await User.findById(req.userId).populate('followRequests', 'username fullName avatar isVerified');
    res.json(me.followRequests);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
