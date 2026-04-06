const mongoose = require('mongoose');

const reelCommentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  replies: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: String,
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

const reelSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  videoUrl: { type: String, required: true },
  publicId: { type: String },
  thumbnail: { type: String, default: '' },
  caption: { type: String, default: '', maxlength: 2200 },
  audio: { title: String, artist: String, url: String, isOriginal: { type: Boolean, default: true } },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [reelCommentSchema],
  views: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  shares: { type: Number, default: 0 },
  tags: [String],
  duration: { type: Number, default: 0 },
  isPublic: { type: Boolean, default: true },
}, { timestamps: true });

reelSchema.index({ author: 1, createdAt: -1 });

module.exports = mongoose.model('Reel', reelSchema);
