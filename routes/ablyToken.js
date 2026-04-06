const express = require('express');
const router = express.Router();
const Ably = require('ably');
const auth = require('../middleware/auth');

router.get('/token', auth, (req, res) => {
  const client = new Ably.Rest(process.env.NEXT_PUBLIC_ABLY_API_KEY);
  const tokenParams = { clientId: req.userId.toString() };
  client.auth.createTokenRequest(tokenParams, (err, tokenRequest) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(tokenRequest);
  });
});

module.exports = router;
