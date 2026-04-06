// upload.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

router.post('/', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const { folder = 'peopulse', type = 'image' } = req.body;
    const resourceType = type === 'video' || type === 'reel' ? 'video' : type === 'raw' ? 'raw' : 'image';

    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, transformation: type === 'image' ? [{ quality: 'auto', fetch_format: 'auto' }] : [] },
      (error, result) => {
        if (error) return res.status(500).json({ error: error.message });
        res.json({ url: result.secure_url, publicId: result.public_id, type: resourceType, format: result.format, duration: result.duration });
      }
    );
    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
