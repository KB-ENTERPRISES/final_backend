// src/routes/notifications.js
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// GET /api/notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'CREW') {
      ({ rows } = await pool.query(
        `SELECT id, message, read, time
         FROM notifications
         WHERE crew_id = $1
         ORDER BY time DESC
         LIMIT 100`,
        [req.user.crewId]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT id, message, read, time
         FROM notifications
         WHERE user_id = $1
         ORDER BY time DESC
         LIMIT 100`,
        [req.user.id]
      ));
    }
    res.json(rows);
  } catch (err) {
    console.error('[GET /notifications]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PATCH /api/notifications/mark-read
router.patch('/mark-read', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'CREW') {
      await pool.query(
        `UPDATE notifications SET read = TRUE WHERE crew_id = $1`,
        [req.user.crewId]
      );
    } else {
      await pool.query(
        `UPDATE notifications SET read = TRUE WHERE user_id = $1`,
        [req.user.id]
      );
    }
    res.status(204).end();
  } catch (err) {
    console.error('[PATCH /notifications/mark-read]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/notifications — clear all (must stay above /:id)
router.delete('/', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'CREW') {
      await pool.query(
        `DELETE FROM notifications WHERE crew_id = $1`,
        [req.user.crewId]
      );
    } else {
      await pool.query(
        `DELETE FROM notifications WHERE user_id = $1`,
        [req.user.id]
      );
    }
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /notifications/]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/notifications/:id — delete single (IDOR-safe)
router.delete('/:id', requireAuth, async (req, res) => {
  const notifId = parseInt(req.params.id, 10);
  if (!Number.isInteger(notifId) || notifId < 1)
    return res.status(400).json({ error: 'Invalid notification ID' });

  try {
    let result;
    if (req.user.role === 'CREW') {
      result = await pool.query(
        `DELETE FROM notifications WHERE id = $1 AND crew_id = $2`,
        [notifId, req.user.crewId]
      );
    } else {
      result = await pool.query(
        `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
        [notifId, req.user.id]
      );
    }
    if (!result.rowCount)
      return res.status(404).json({ error: 'Notification not found' });
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /notifications/:id]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
