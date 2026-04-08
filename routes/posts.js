const express = require('express');
const router  = express.Router();
const Post    = require('../models/Post');
const User    = require('../models/User');
const Notification = require('../models/Notification');
const auth    = require('../middleware/auth');

// Create post
router.post('/', auth, async (req, res) => {
  try {
    const { type, caption, media, textContent, textStyle, tags, taggedUsers, location, hideLikes, disableComments } = req.body;
    const post = new Post({
      author: req.userId, type: type||'post', caption, media: media||[],
      textContent, textStyle, tags, taggedUsers, location, hideLikes, disableComments,
      storyExpiry: type==='story' ? new Date(Date.now() + 24*60*60*1000) : undefined,
    });
    await post.save();
    await post.populate('author', 'username fullName avatar isVerified');

    if (taggedUsers?.length) {
      const notifs = taggedUsers.map(u => ({ recipient: u, sender: req.userId, type: 'tag', post: post._id }));
      const created = await Notification.insertMany(notifs);
      const io = req.app.get('io');
      created.forEach(n => io?.notifyUser(n.recipient.toString(), 'notification:new', n));
    }
    res.status(201).json(post);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feed
router.get('/feed', auth, async (req, res) => {
  try {
    const { page=1, limit=10 } = req.query;
    const me = await User.findById(req.userId);
    const posts = await Post.find({
      author: { $in: [...me.following, req.userId] },
      type: { $in: ['post','text'] }, isArchived: false
    }).sort({ createdAt: -1 })
      .skip((page-1)*limit).limit(+limit)
      .populate('author', 'username fullName avatar isVerified')
      .populate('taggedUsers', 'username fullName avatar');
    res.json(posts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Explore
router.get('/explore', auth, async (req, res) => {
  try {
    const { page=1, limit=20 } = req.query;
    const me = await User.findById(req.userId);
    const posts = await Post.find({
      type: { $in: ['post','text'] }, isArchived: false,
      author: { $nin: [...me.blockedUsers, req.userId] }
    }).sort({ likes: -1, createdAt: -1 })
      .skip((page-1)*limit).limit(+limit)
      .populate('author', 'username fullName avatar isVerified');
    res.json(posts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Single post
router.get('/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('author', 'username fullName avatar isVerified')
      .populate('comments.user', 'username fullName avatar isVerified')
      .populate('comments.replies.user', 'username fullName avatar')
      .populate('taggedUsers', 'username fullName avatar');
    if (!post) return res.status(404).json({ error: 'Not found' });
    res.json(post);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// User posts
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const { type, page=1, limit=12 } = req.query;
    const query = { author: req.params.userId, isArchived: false };
    if (type) query.type = type; else query.type = { $in: ['post','text'] };
    const posts = await Post.find(query).sort({ createdAt: -1 })
      .skip((page-1)*limit).limit(+limit)
      .populate('author', 'username fullName avatar isVerified');
    res.json(posts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Like / Unlike
router.post('/:id/like', auth, async (req, res) => {
  try {
    const io   = req.app.get('io');
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    const liked = post.likes.includes(req.userId);
    if (liked) post.likes.pull(req.userId);
    else {
      post.likes.push(req.userId);
      if (post.author.toString() !== req.userId.toString()) {
        const notif = await Notification.create({ recipient: post.author, sender: req.userId, type: 'like', post: post._id });
        await notif.populate('sender', 'username fullName avatar');
        io?.notifyUser(post.author.toString(), 'notification:new', notif);
      }
    }
    await post.save();
    // Broadcast like update to all connected clients
    io?.emit('post:like:update', { postId: post._id, likesCount: post.likes.length, userId: req.userId, liked: !liked });
    res.json({ liked: !liked, likesCount: post.likes.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add comment
router.post('/:id/comment', auth, async (req, res) => {
  try {
    const io   = req.app.get('io');
    const { text } = req.body;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (post.disableComments) return res.status(403).json({ error: 'Comments disabled' });
    post.comments.push({ user: req.userId, text, likes: [], replies: [] });
    await post.save();
    await Post.populate(post, { path: 'comments.user', select: 'username fullName avatar isVerified' });
    const newComment = post.comments[post.comments.length - 1];
    if (post.author.toString() !== req.userId.toString()) {
      const notif = await Notification.create({ recipient: post.author, sender: req.userId, type: 'comment', post: post._id, message: text });
      await notif.populate('sender', 'username fullName avatar');
      io?.notifyUser(post.author.toString(), 'notification:new', notif);
    }
    io?.emit('post:comment:update', { postId: post._id, commentsCount: post.comments.length });
    res.json(newComment);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete comment
router.delete('/:postId/comment/:commentId', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.user.toString() !== req.userId.toString() && post.author.toString() !== req.userId.toString())
      return res.status(403).json({ error: 'Not authorized' });
    comment.deleteOne();
    await post.save();
    const io = req.app.get('io');
    io?.emit('post:comment:update', { postId: post._id, commentsCount: post.comments.length });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Like comment
router.post('/:postId/comment/:commentId/like', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Not found' });
    const liked = comment.likes.includes(req.userId);
    if (liked) comment.likes.pull(req.userId); else comment.likes.push(req.userId);
    await post.save();
    res.json({ liked: !liked, likesCount: comment.likes.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reply to comment
router.post('/:postId/comment/:commentId/reply', auth, async (req, res) => {
  try {
    const { text } = req.body;
    const post    = await Post.findById(req.params.postId);
    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Not found' });
    comment.replies.push({ user: req.userId, text });
    await post.save();
    await Post.populate(post, { path: 'comments.replies.user', select: 'username fullName avatar' });
    res.json(comment.replies[comment.replies.length - 1]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete post (also deletes Cloudinary media)
router.delete('/:id', auth, async (req, res) => {
  try {
    const cloudinary = req.app.get('cloudinary');
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (post.author.toString() !== req.userId.toString()) return res.status(403).json({ error: 'Not authorized' });
    // Delete media from Cloudinary
    if (post.media?.length) {
      await Promise.all(post.media.filter(m => m.publicId).map(m =>
        cloudinary.uploader.destroy(m.publicId, { resource_type: m.type==='video' ? 'video' : 'image' }).catch(() => {})
      ));
    }
    await post.deleteOne();
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save / Unsave
router.post('/:id/save', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const isSaved = user.savedPosts.includes(req.params.id);
    if (isSaved) await User.findByIdAndUpdate(req.userId, { $pull: { savedPosts: req.params.id } });
    else         await User.findByIdAndUpdate(req.userId, { $push: { savedPosts: req.params.id } });
    res.json({ saved: !isSaved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Saved posts
router.get('/saved/list', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).populate({
      path: 'savedPosts', populate: { path: 'author', select: 'username fullName avatar isVerified' }
    });
    res.json(user.savedPosts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Archive
router.post('/:id/archive', auth, async (req, res) => {
  try {
    const post = await Post.findOneAndUpdate(
      { _id: req.params.id, author: req.userId },
      [{ $set: { isArchived: { $not: '$isArchived' } } }],
      { new: true }
    );
    res.json({ isArchived: post.isArchived });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stories feed
router.get('/stories/feed', auth, async (req, res) => {
  try {
    const me = await User.findById(req.userId);
    const now = new Date();
    const stories = await Post.find({
      author: { $in: [...me.following, req.userId] },
      type: 'story', storyExpiry: { $gt: now }
    }).sort({ createdAt: -1 })
      .populate('author', 'username fullName avatar isVerified')
      .populate('storyViewers.user', 'username fullName avatar');
    const grouped = stories.reduce((acc, s) => {
      const id = s.author._id.toString();
      if (!acc[id]) acc[id] = { user: s.author, stories: [] };
      acc[id].stories.push(s);
      return acc;
    }, {});
    res.json(Object.values(grouped));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// View story
router.post('/stories/:id/view', auth, async (req, res) => {
  try {
    const story = await Post.findById(req.params.id);
    if (!story) return res.status(404).json({ error: 'Not found' });
    if (!story.storyViewers.some(v => v.user.toString() === req.userId.toString()))
      story.storyViewers.push({ user: req.userId, viewedAt: new Date() });
    await story.save();
    res.json({ viewed: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tagged posts
router.get('/tagged/:userId', auth, async (req, res) => {
  try {
    const posts = await Post.find({ taggedUsers: req.params.userId, isArchived: false })
      .populate('author', 'username fullName avatar isVerified').sort({ createdAt: -1 });
    res.json(posts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
