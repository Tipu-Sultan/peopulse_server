const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['text', 'image', 'video', 'audio', 'file', 'call', 'system'], default: 'text' },
  content: { type: String, default: '' },
  media: [{
    url: String,
    publicId: String,
    type: String,
    name: String,
    size: Number,
    thumbnail: String,
  }],
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  readBy: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, readAt: Date }],
  deliveredTo: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, deliveredAt: Date }],
  isEdited: { type: Boolean, default: false },
  editedAt: { type: Date },
  editHistory: [{ content: String, editedAt: Date }],
  isDeleted: { type: Boolean, default: false },
  deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  deletedForEveryone: { type: Boolean, default: false },
  reactions: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, emoji: String }],
  callData: {
    type: { type: String, enum: ['audio', 'video'] },
    duration: Number,
    status: { type: String, enum: ['missed', 'answered', 'rejected', 'ongoing'] }
  },
}, { timestamps: true });

messageSchema.index({ conversation: 1, createdAt: -1 });

const conversationSchema = new mongoose.Schema({
  type: { type: String, enum: ['direct', 'group'], default: 'direct' },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  admins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  name: { type: String, default: '' },
  avatar: { type: String, default: '' },
  description: { type: String, default: '' },
  lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  lastActivity: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Group settings
  onlyAdminsCanMessage: { type: Boolean, default: false },
  onlyAdminsCanEditInfo: { type: Boolean, default: false },
  joinLink: { type: String, default: '' },
  pinnedMessages: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Message' }],
  // Per-user settings stored separately
  mutedBy: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, until: Date }],
  deletedBy: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, deletedAt: Date }],
  blockedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

const Message = mongoose.model('Message', messageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);

module.exports = { Message, Conversation };
