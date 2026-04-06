const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, maxlength: 1000 },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  replies: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: { type: String, maxlength: 500 },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdAt: { type: Date, default: Date.now }
  }],
}, { timestamps: true });

const postSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['post', 'text', 'story', 'reel'], default: 'post' },
  caption: { type: String, default: '', maxlength: 2200 },
  media: [{
    url: { type: String },
    publicId: { type: String },
    type: { type: String, enum: ['image', 'video'] },
    thumbnail: { type: String }
  }],
  textContent: { type: String, default: '' },
  textStyle: {
    background: { type: String, default: '#000' },
    color: { type: String, default: '#fff' },
    fontSize: { type: Number, default: 24 },
    fontFamily: { type: String, default: 'default' },
    align: { type: String, default: 'center' }
  },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [commentSchema],
  tags: [{ type: String }],
  taggedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  location: { type: String, default: '' },
  isArchived: { type: Boolean, default: false },
  hideLikes: { type: Boolean, default: false },
  disableComments: { type: Boolean, default: false },
  views: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  shares: { type: Number, default: 0 },
  // Story specific
  storyExpiry: { type: Date },
  storyViewers: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, viewedAt: Date }],
  music: { title: String, artist: String, url: String },
}, { timestamps: true });

postSchema.index({ author: 1, createdAt: -1 });
postSchema.index({ tags: 1 });
postSchema.index({ type: 1 });

module.exports = mongoose.model('Post', postSchema);
