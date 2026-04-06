const express = require('express');
const router = express.Router();
const Post = require('../models/Post');
const User = require('../models/User');
const Notification = require('../models/Notification');
const auth = require('../middleware/auth');

// Create post
router.post('/', auth, async (req, res) => {
  try {
    const { type, caption, media, textContent, textStyle, tags, taggedUsers, location, hideLikes, disableComments } = req.body;
    const post = new Post({
      author: req.userId,
      type: type || 'post',
      caption,
      media: media || [],
      textContent,
      textStyle,
      tags,
      taggedUsers,
      location,
      hideLikes,
      disableComments,
      storyExpiry: type === 'story' ? new Date(Date.now() + 24 * 60 * 60 * 1000) : undefined,
    });
    await post.save();
    await post.populate('author', 'username fullName avatar isVerified');

    // Notify tagged users
    if (taggedUsers?.length) {
      const notifs = taggedUsers.map(u => ({ recipient: u, sender: req.userId, type: 'tag', post: post._id }));
      await Notification.insertMany(notifs);
    }

    res.status(201).json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get feed
router.get('/feed', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const currentUser = await User.findById(req.userId);
    const following = [...currentUser.following, req.userId];

    const posts = await Post.find({
      author: { $in: following },
      type: { $in: ['post', 'text'] },
      isArchived: false
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('author', 'username fullName avatar isVerified')
      .populate('taggedUsers', 'username fullName avatar');

    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get explore posts
router.get('/explore', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const currentUser = await User.findById(req.userId);
    const posts = await Post.find({
      type: { $in: ['post', 'text'] },
      isArchived: false,
      author: { $nin: [...currentUser.blockedUsers, req.userId] }
    })
      .sort({ likes: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('author', 'username fullName avatar isVerified');

    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user posts
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const { type, page = 1, limit = 12 } = req.query;
    const query = { author: req.params.userId, isArchived: false };
    if (type) query.type = type;
    else query.type = { $in: ['post', 'text'] };

    const posts = await Post.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('author', 'username fullName avatar isVerified');
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Like / Unlike post
router.post('/:id/like', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const hasLiked = post.likes.includes(req.userId);
    if (hasLiked) {
      post.likes.pull(req.userId);
    } else {
      post.likes.push(req.userId);
      if (post.author.toString() !== req.userId.toString()) {
        await Notification.create({ recipient: post.author, sender: req.userId, type: 'like', post: post._id });
      }
    }
    await post.save();
    res.json({ liked: !hasLiked, likesCount: post.likes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add comment
router.post('/:id/comment', auth, async (req, res) => {
  try {
    const { text } = req.body;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.disableComments) return res.status(403).json({ error: 'Comments disabled' });

    const comment = { user: req.userId, text, likes: [], replies: [] };
    post.comments.push(comment);
    await post.save();

    const newComment = post.comments[post.comments.length - 1];
    await Post.populate(post, { path: 'comments.user', select: 'username fullName avatar isVerified' });

    if (post.author.toString() !== req.userId.toString()) {
      await Notification.create({ recipient: post.author, sender: req.userId, type: 'comment', post: post._id, message: text });
    }

    res.json(post.comments.find(c => c._id.toString() === newComment._id.toString()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Like comment
router.post('/:postId/comment/:commentId/like', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    const hasLiked = comment.likes.includes(req.userId);
    if (hasLiked) comment.likes.pull(req.userId);
    else comment.likes.push(req.userId);
    await post.save();
    res.json({ liked: !hasLiked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reply to comment
router.post('/:postId/comment/:commentId/reply', auth, async (req, res) => {
  try {
    const { text } = req.body;
    const post = await Post.findById(req.params.postId);
    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    comment.replies.push({ user: req.userId, text });
    await post.save();
    res.json(comment.replies[comment.replies.length - 1]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    res.json({ message: 'Comment deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete post
router.delete('/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.author.toString() !== req.userId.toString()) return res.status(403).json({ error: 'Not authorized' });

    await post.deleteOne();
    res.json({ message: 'Post deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save / Unsave post
router.post('/:id/save', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const isSaved = user.savedPosts.includes(req.params.id);

    if (isSaved) await User.findByIdAndUpdate(req.userId, { $pull: { savedPosts: req.params.id } });
    else await User.findByIdAndUpdate(req.userId, { $push: { savedPosts: req.params.id } });

    res.json({ saved: !isSaved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get saved posts
router.get('/saved/list', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).populate({
      path: 'savedPosts',
      populate: { path: 'author', select: 'username fullName avatar isVerified' }
    });
    res.json(user.savedPosts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Archive post
router.post('/:id/archive', auth, async (req, res) => {
  try {
    const post = await Post.findOneAndUpdate(
      { _id: req.params.id, author: req.userId },
      [{ $set: { isArchived: { $not: '$isArchived' } } }],
      { new: true }
    );
    res.json({ isArchived: post.isArchived });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get stories
router.get('/stories/feed', auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.userId);
    const following = [...currentUser.following, req.userId];
    const now = new Date();

    const stories = await Post.find({
      author: { $in: following },
      type: 'story',
      storyExpiry: { $gt: now }
    })
      .sort({ createdAt: -1 })
      .populate('author', 'username fullName avatar isVerified');

    // Group by user
    const grouped = stories.reduce((acc, story) => {
      const authorId = story.author._id.toString();
      if (!acc[authorId]) acc[authorId] = { user: story.author, stories: [] };
      acc[authorId].stories.push(story);
      return acc;
    }, {});

    res.json(Object.values(grouped));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// View story
router.post('/stories/:id/view', auth, async (req, res) => {
  try {
    const story = await Post.findById(req.params.id);
    if (!story.storyViewers.some(v => v.user.toString() === req.userId.toString())) {
      story.storyViewers.push({ user: req.userId, viewedAt: new Date() });
      await story.save();
    }
    res.json({ viewed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get tagged posts for user
router.get('/tagged/:userId', auth, async (req, res) => {
  try {
    const posts = await Post.find({ taggedUsers: req.params.userId, isArchived: false })
      .populate('author', 'username fullName avatar isVerified')
      .sort({ createdAt: -1 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single post  ← must come AFTER all static GET routes
router.get('/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('author', 'username fullName avatar isVerified')
      .populate('comments.user', 'username fullName avatar isVerified')
      .populate('taggedUsers', 'username fullName avatar');
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;