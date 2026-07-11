// src/routes/orders.js
// All order-related endpoints

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sanitizeText } = require('../utils/sanitize');

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function generateOrderId(client) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).replace(/-/g, '');
  let attempts = 0;
  while (attempts < 10) {
    const randomSeq = String(Math.floor(1000 + Math.random() * 9000));
    const candidateId = `ORD-${today}-${randomSeq}`;
    const { rows } = await client.query('SELECT 1 FROM orders WHERE id = $1', [candidateId]);
    if (!rows.length) {
      return candidateId;
    }
    attempts++;
  }
  return `ORD-${today}-${Date.now().toString().slice(-4)}`;
}

// ── Helper: fetch full order rows with items ─────────────────────────
// whereClause must only ever be a hardcoded string — never user input.
async function fetchOrders(whereClause = '', params = []) {
  const { rows } = await pool.query(
    `SELECT
       o.id,
       o.user_id           AS "userId",
       o.user_name         AS "userName",
       u.phone             AS "userPhone",
       o.train_no          AS "trainNo",
       o.train_name        AS "trainName",
       o.current_location  AS "currentLocation",
       o.eta,
       o.order_type        AS "orderType",
       o.stall_name        AS "stallName",
       o.stall_location    AS "stallLocation",
       o.status,
       o.assigned_crew_id  AS "assignedCrewId",
       o.total,
       o.payment_uploaded  AS "paymentUploaded",
       o.delivery_note     AS "deliveryNote",
       o.original_total    AS "originalTotal",
       o.created_at        AS "createdAt",
       o.accepted_at       AS "acceptedAt",
       o.completed_at      AS "completedAt",
       EXTRACT(EPOCH FROM (o.accepted_at - o.created_at))    AS "acceptanceDurationSeconds",
       EXTRACT(EPOCH FROM (o.completed_at - o.accepted_at))  AS "deliveryDurationSeconds"
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     ${whereClause}
     ORDER BY o.created_at DESC`,
    params
  );
  
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const { rows: items } = await pool.query(
    `SELECT order_id AS "orderId", product_id AS "productId", name, qty, price,
            delivered_qty AS "deliveredQty"
     FROM order_items
     WHERE order_id = ANY($1)`,
    [ids]
  );

  return rows.map(o => ({
    ...o,
    items: items.filter(i => i.orderId === o.id),
  }));
}

// ── POST /orders ─────────────────────────────────────────────────────
router.post('/', ...requireRole('USER', 'ADMIN'), async (req, res) => {
  const {
    orderType = 'train',
    userName, trainNo, trainName, currentLocation, eta,
    stallName, stallLocation,
    items
  } = req.body;

  if (userName && userName.length > 100)
    return res.status(400).json({ error: 'Name is too long (max 100 characters)' });
  if (trainName && trainName.length > 150)
    return res.status(400).json({ error: 'Train name is too long (max 150 characters)' });
  if (!items || !Array.isArray(items) || items.length === 0 || items.length > 50)
    return res.status(400).json({ error: 'Invalid items list' });

  const rawTrainNo = String(trainNo || '').trim();
  if (orderType === 'train') {
    if (!userName || !rawTrainNo || !trainName || !currentLocation || !eta) {
      return res.status(400).json({ error: 'All train order fields are required' });
    }
    if (rawTrainNo.length > 30) {
      return res.status(400).json({ error: 'Train number is too long (max 30 characters)' });
    }
  } else if (orderType === 'stall') {
    if (!userName || !stallName) {
      return res.status(400).json({ error: 'Stall owner name and stall name are required' });
    }
  } else {
    return res.status(400).json({ error: 'Invalid orderType' });
  }

  // Validate items and resolve prices from the trusted product catalog
  for (const item of items) {
    if (!item.productId || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 10000) {
      return res.status(400).json({ error: 'Invalid item: productId and qty are required' });
    }
  }

  const sanitizedUserName     = sanitizeText(userName?.trim() || '');
  const sanitizedTrainNo      = sanitizeText(rawTrainNo);
  const sanitizedTrainName    = sanitizeText(trainName?.trim() || '');
  const sanitizedCurrentLoc   = sanitizeText(currentLocation?.trim() || '');
  const sanitizedEta          = sanitizeText(eta?.trim() || '');
  const sanitizedStallName    = sanitizeText(stallName?.trim() || '');
  const sanitizedStallLoc     = sanitizeText(stallLocation?.trim() || '');

  const userId = req.user.role === 'CREW' ? null : (req.user.id || null);
  const client = await pool.connect();

  try {
    const productIds = items.map(i => i.productId);
    const { rows: products } = await client.query(
      `SELECT id, name, price FROM products WHERE id = ANY($1) AND in_stock = true AND deleted = false`,
      [productIds]
    );
    const productMap = new Map(products.map(p => [p.id, p]));

    for (const item of items) {
      if (!productMap.has(item.productId)) {
        return res.status(400).json({ error: `Product "${item.productId}" is unavailable or out of stock` });
      }
    }

    const total = items.reduce((sum, item) => {
      const product = productMap.get(item.productId);
      return sum + Number(product.price) * item.qty;
    }, 0);

    await client.query('BEGIN');

    const orderId = await generateOrderId(client);

    await client.query(
      `INSERT INTO orders
         (id, user_id, user_name, train_no, train_name, current_location, eta, total, order_type, stall_name, stall_location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        orderId,
        userId,
        sanitizedUserName,
        orderType === 'train' ? sanitizedTrainNo : '',
        orderType === 'train' ? sanitizedTrainName : sanitizedStallName,
        orderType === 'train' ? sanitizedCurrentLoc : (sanitizedStallLoc || sanitizedStallName),
        orderType === 'train' ? sanitizedEta : 'N/A',
        total,
        orderType,
        orderType === 'stall' ? sanitizedStallName : null,
        orderType === 'stall' ? (sanitizedStallLoc || null) : null,
      ]
    );

    for (const item of items) {
      const product = productMap.get(item.productId);
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name, qty, price)
         VALUES ($1,$2,$3,$4,$5)`,
        [orderId, item.productId, product.name, item.qty, Number(product.price)]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (order_id, event, performed_by, note)
       VALUES ($1, 'PLACED', $2, 'Order placed')`,
      [orderId, req.user.name || req.user.email]
    );

    const { rows: admins } = await client.query(
      `SELECT id FROM users WHERE role = 'ADMIN'`
    );
    for (const admin of admins) {
      await client.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [admin.id, `New order ${orderId} placed by ${sanitizedUserName} — Rs.${total}`]
      );
    }

    if (userId) {
      await client.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [userId, `SLIP:${orderId}:Your order ${orderId} has been successfully placed for Rs.${total}.`]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: orderId, total });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /orders]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// ── GET /orders/my ───────────────────────────────────────────────────
router.get('/my', requireAuth, async (req, res) => {
  try {
    const orders = await fetchOrders('WHERE o.user_id = $1', [req.user.id]);
    res.json(orders);
  } catch (err) {
    console.error('[GET /orders/my]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── GET /orders/pending ──────────────────────────────────────────────
router.get('/pending', ...requireRole('CREW', 'ADMIN'), async (req, res) => {
  try {
    const orders = await fetchOrders(`WHERE o.status = 'PENDING'`);
    res.json(orders);
  } catch (err) {
    console.error('[GET /orders/pending]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── GET /orders/deliveries ───────────────────────────────────────────
router.get('/deliveries', ...requireRole('CREW'), async (req, res) => {
  try {
    const orders = await fetchOrders(
      `WHERE o.assigned_crew_id = $1 AND o.status != 'PENDING'`,
      [req.user.crewId]
    );
    res.json(orders);
  } catch (err) {
    console.error('[GET /orders/deliveries]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── GET /orders/all ──────────────────────────────────────────────────
router.get('/all', ...requireRole('ADMIN'), async (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    let orders;
    if (date) {
      orders = await fetchOrders("WHERE (o.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1", [date]);
    } else {
      orders = await fetchOrders();
    }
    res.json(orders);
  } catch (err) {
    console.error('[GET /orders/all]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── GET /orders/stats ────────────────────────────────────────────────
router.get('/stats', ...requireRole('ADMIN'), async (req, res) => {
  try {
    const date = String(req.query.date || todayIST()).trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                           AS "totalOrders",
        COUNT(*) FILTER (WHERE status = 'PENDING')        AS pending,
        COUNT(*) FILTER (WHERE status = 'ACCEPTED')       AS accepted,
        COUNT(*) FILTER (WHERE status = 'COMPLETED')      AS completed,
        COALESCE(SUM(total) FILTER (WHERE status = 'COMPLETED'), 0) AS revenue
      FROM orders
      WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = $1
    `, [date]);
    const s = rows[0];
    res.json({
      totalOrders: parseInt(s.totalOrders),
      pending:     parseInt(s.pending),
      accepted:    parseInt(s.accepted),
      completed:   parseInt(s.completed),
      revenue:     parseFloat(s.revenue),
      date,
    });
  } catch (err) {
    console.error('[GET /orders/stats]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── PATCH /orders/:id/accept ─────────────────────────────────────────
router.patch('/:id/accept', ...requireRole('CREW'), async (req, res) => {
  const { id } = req.params;
  const client  = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE orders
       SET status = 'ACCEPTED', assigned_crew_id = $1, accepted_at = NOW()
       WHERE id = $2 AND status = 'PENDING'
       RETURNING *`,
      [req.user.crewId, id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Order is no longer available' });
    }

    await client.query(
      `INSERT INTO audit_logs (order_id, event, performed_by, note)
       VALUES ($1, 'ACCEPTED', $2, 'Order accepted by crew')`,
      [id, req.user.name]
    );

    const o = rows[0];
    if (o.user_id) {
      await client.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [o.user_id, `Your order ${id} has been accepted by crew and is being prepared.`]
      );
    }

    const { rows: admins } = await client.query(
      `SELECT id FROM users WHERE role = 'ADMIN'`
    );
    for (const admin of admins) {
      await client.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [admin.id, `Order ${id} has been accepted by crew member ${req.user.name}.`]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Order accepted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PATCH /orders/:id/accept]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// ── PATCH /orders/:id/assign ─────────────────────────────────────────
router.patch('/:id/assign', ...requireRole('ADMIN'), async (req, res) => {
  const { id }     = req.params;
  const { crewId } = req.body;
  if (!crewId) return res.status(400).json({ error: 'crewId is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: crewRows } = await client.query(
      `SELECT crew_id FROM crew WHERE crew_id = $1`,
      [crewId]
    );
    if (!crewRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Crew member not found' });
    }

    const { rows } = await client.query(
      `UPDATE orders
       SET assigned_crew_id = $1, status = 'ACCEPTED', accepted_at = COALESCE(accepted_at, NOW())
       WHERE id = $2
       RETURNING *`,
      [crewId, id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    await client.query(
      `INSERT INTO audit_logs (order_id, event, performed_by, note)
       VALUES ($1, 'ASSIGNED', $2, $3)`,
      [id, req.user.name, `Crew ${crewId} assigned by admin`]
    );

    await client.query(
      `INSERT INTO notifications (crew_id, message) VALUES ($1, $2)`,
      [crewId, `You have been assigned to order ${id}.`]
    );

    const o = rows[0];
    if (o.user_id) {
      await client.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [o.user_id, `Crew member ${crewId} has been assigned to deliver your order ${id}.`]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Crew assigned' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PATCH /orders/:id/assign]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// ── PATCH /orders/:id/payment-screenshot ─────────────────────────────
// Accepts a URL from imgbb.com or podu.pics, stores it, and atomically
// marks the order as COMPLETED in the same transaction.
router.patch('/:id/payment-screenshot', ...requireRole('CREW', 'ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { screenshotBase64, amountPaid = 0, deliveredItems, description = '' } = req.body;

  if (!screenshotBase64) {
    return res.status(400).json({ error: 'Payment screenshot is required' });
  }
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/.exec(screenshotBase64);
  if (!match) {
    return res.status(400).json({ error: 'Invalid image format' });
  }
  const mime = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const imageBuffer = Buffer.from(match[2], 'base64');
  if (imageBuffer.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: 'Screenshot is too large (max 8MB)' });
  }

  const paid = Number(amountPaid);
  if (isNaN(paid) || paid < 0 || paid > 1000000) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  if (!Array.isArray(deliveredItems) || !deliveredItems.length) {
    return res.status(400).json({ error: 'deliveredItems is required' });
  }

  const rawDescription = String(description || '').trim().slice(0, 500);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: orderRows } = await client.query(
      `SELECT total, status FROM orders WHERE id = $1 AND (assigned_crew_id = $2 OR $3 = 'ADMIN')`,
      [id, req.user.crewId || null, req.user.role]
    );
    if (!orderRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found or not assigned to you' });
    }
    if (orderRows[0].status === 'COMPLETED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This order has already been completed.' });
    }
    const originalTotal = Number(orderRows[0].total);

    const { rows: orderItemRows } = await client.query(
      `SELECT product_id, name, qty, price FROM order_items WHERE order_id = $1`,
      [id]
    );
    if (!orderItemRows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No items found for this order' });
    }
    const itemMap = new Map(orderItemRows.map(i => [i.product_id, i]));

    let deliveredTotal = 0;
    const validatedDeliveries = [];
    for (const d of deliveredItems) {
      const pid = String(d.productId || '');
      const orderItem = itemMap.get(pid);
      if (!orderItem) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Item "${pid}" does not belong to this order` });
      }
      const deliveredQty = Number(d.deliveredQty);
      if (!Number.isInteger(deliveredQty) || deliveredQty < 0 || deliveredQty > orderItem.qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Invalid delivered quantity for ${orderItem.name}` });
      }
      deliveredTotal += deliveredQty * Number(orderItem.price);
      validatedDeliveries.push({ productId: pid, deliveredQty });
    }

    if (Math.abs(paid - deliveredTotal) > 0.01) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Amount does not match deliverable total (expected Rs.${deliveredTotal.toFixed(2)})` });
    }

    for (const d of validatedDeliveries) {
      await client.query(
        `UPDATE order_items SET delivered_qty = $1 WHERE order_id = $2 AND product_id = $3`,
        [d.deliveredQty, id, d.productId]
      );
    }

    await client.query(
      `INSERT INTO payment_screenshots
         (order_id, screenshot_data, screenshot_mime, amount_paid, uploaded_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, imageBuffer, mime, paid, req.user.name]
    );

    const { rows } = await client.query(
      `UPDATE orders
       SET payment_uploaded = TRUE,
           status = 'COMPLETED',
           completed_at = NOW(),
           original_total = COALESCE(original_total, total),
           total = $4,
           delivery_note = $5
       WHERE id = $1 AND (assigned_crew_id = $2 OR $3 = 'ADMIN') AND status != 'COMPLETED'
       RETURNING *`,
      [id, req.user.crewId || null, req.user.role, deliveredTotal, rawDescription || null]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found or not assigned to you' });
    }

    const isPartial = deliveredTotal < originalTotal - 0.01;
    await client.query(
      `INSERT INTO audit_logs (order_id, event, performed_by, note)
       VALUES ($1, 'COMPLETED', $2, $3)`,
      [id, req.user.name, isPartial
        ? `Order completed with partial delivery (Rs.${deliveredTotal.toFixed(2)} of Rs.${originalTotal.toFixed(2)})${rawDescription ? ' — ' + rawDescription : ''}`
        : 'Order completed with payment screenshot']
    );

    const o = rows[0];
    if (o.user_id) {
      await client.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [o.user_id, `RECEIPT:${id}:Your order ${id} has been delivered! Tap to view your receipt.`]
      );
    }

    const { rows: admins } = await client.query(`SELECT id FROM users WHERE role = 'ADMIN'`);
    const actorName = sanitizeText(req.user.name || req.user.email || '');
    for (const admin of admins) {
      await client.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [admin.id, `RECEIPT:${id}:Order ${id} completed by ${actorName}. Tap to view receipt.`]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Payment recorded and order completed' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PATCH /orders/:id/payment-screenshot]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// ── PATCH /orders/:id/complete ───────────────────────────────────────
// Admin-only manual completion (no screenshot required)
router.patch('/:id/complete', ...requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const client  = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE orders
       SET status = 'COMPLETED', completed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    await client.query(
      `INSERT INTO audit_logs (order_id, event, performed_by, note)
       VALUES ($1, 'COMPLETED', $2, 'Order manually completed by admin')`,
      [id, req.user.name]
    );

    const o = rows[0];
    if (o.user_id) {
      await client.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [o.user_id, `RECEIPT:${id}:Your order ${id} has been delivered! Tap to view your receipt.`]
      );
    }

    const { rows: admins } = await client.query(`SELECT id FROM users WHERE role = 'ADMIN'`);
    const actorName = sanitizeText(req.user.name || req.user.email || '');
    for (const admin of admins) {
      await client.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [admin.id, `RECEIPT:${id}:Order ${id} manually completed by ${actorName}. Tap to view receipt.`]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Order completed' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PATCH /orders/:id/complete]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// ── GET /orders/admin/logs ───────────────────────────────────────────
router.get('/admin/logs', ...requireRole('ADMIN'), async (req, res) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit  || '100', 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const { rows } = await pool.query(
      `SELECT id, order_id AS "orderId", event,
              performed_by AS "performedBy", note,
              event_time AS "eventTime"
       FROM audit_logs
       ORDER BY event_time DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /orders/admin/logs]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── GET /orders/admin/delivery-logs ─────────────────────────────────
router.get('/admin/delivery-logs', ...requireRole('ADMIN'), async (req, res) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit  || '100', 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const { rows } = await pool.query(
      `SELECT
         o.id                                                          AS "orderId",
         o.train_no                                                    AS "trainNo",
         o.train_name                                                  AS "trainName",
         o.eta                                                         AS "etaGiven",
         o.order_type                                                  AS "orderType",
         o.stall_name                                                  AS "stallName",
         o.created_at                                                  AS "placedAt",
         o.accepted_at                                                 AS "acceptedAt",
         o.completed_at                                                AS "deliveredAt",
         EXTRACT(EPOCH FROM (o.accepted_at - o.created_at))           AS "acceptanceDurationSeconds",
         EXTRACT(EPOCH FROM (o.completed_at - o.accepted_at))         AS "deliveryDurationSeconds"
       FROM orders o
       ORDER BY o.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /orders/admin/delivery-logs]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── GET /orders/admin/payments ───────────────────────────────────────
router.get('/admin/payments', ...requireRole('ADMIN'), async (req, res) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit  || '100', 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const { rows } = await pool.query(
      `SELECT
         p.id,
         p.order_id          AS "orderId",
         (p.screenshot_data IS NOT NULL) AS "hasScreenshot",
         p.amount_paid       AS "amountPaid",
         p.uploaded_by       AS "uploadedBy",
         p.uploaded_at       AS "uploadedAt"
       FROM payment_screenshots p
       ORDER BY p.uploaded_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /orders/admin/payments]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── GET /orders/payments/:id/image ───────────────────────────────────
// Streams the raw screenshot bytes. Auth-protected (not a public URL).
router.get('/payments/:id/image', ...requireRole('CREW', 'ADMIN'), async (req, res) => {
  const paymentId = parseInt(req.params.id, 10);
  if (!Number.isInteger(paymentId) || paymentId < 1) {
    return res.status(400).json({ error: 'Invalid payment ID' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT screenshot_data, screenshot_mime
       FROM payment_screenshots
       WHERE id = $1`,
      [paymentId]
    );
    if (!rows.length || !rows[0].screenshot_data) {
      return res.status(404).json({ error: 'Screenshot not available (it may have expired after 31 days)' });
    }
    res.setHeader('Content-Type', rows[0].screenshot_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(rows[0].screenshot_data);
  } catch (err) {
    console.error('[GET /orders/payments/:id/image]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── DELETE /orders/:id ────────────────────────────────────────────────
// Admin only: deletes an order and notifies user/crew
router.delete('/:id', ...requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get order details first (user_id and assigned_crew_id)
    const { rows } = await client.query(
      `SELECT user_id, assigned_crew_id FROM orders WHERE id = $1`,
      [id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = rows[0];

    // Notify user if exists
    if (order.user_id) {
      await client.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [order.user_id, `Order ${id} has been cancelled by the administrator.`]
      );
    }

    // Notify assigned crew if exists
    if (order.assigned_crew_id) {
      await client.query(
        `INSERT INTO notifications (crew_id, message) VALUES ($1, $2)`,
        [order.assigned_crew_id, `Assigned order ${id} has been cancelled by the administrator.`]
      );
    }

    // Delete audit logs associated with this order
    await client.query(`DELETE FROM audit_logs WHERE order_id = $1`, [id]);

    // Delete the order itself (cascades to order_items, payment_screenshots)
    await client.query(`DELETE FROM orders WHERE id = $1`, [id]);

    await client.query('COMMIT');
    res.json({ message: 'Order deleted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DELETE /orders/:id]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

module.exports = router;
