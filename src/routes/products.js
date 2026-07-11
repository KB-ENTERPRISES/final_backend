// src/routes/products.js
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireRole } = require('../middleware/auth');

const { sanitizeText } = require('../utils/sanitize');

function isSafeImageUrl(value) {
  if (!value) return true;
  if (typeof value !== 'string') return false;
  if (value.startsWith('data:image/')) {
    return /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(value) && value.length <= 15 * 1024 * 1024;
  }
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && value.length <= 1000;
  } catch {
    return false;
  }
}

// GET /api/products
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, icon, img, price, unit,
              in_stock AS "in_stock",
              case_price AS "case_price",
              pieces_per_case AS "pieces_per_case"
       FROM products
       WHERE deleted = false
       ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /products]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/products — Admin only
router.post('/', ...requireRole('ADMIN'), async (req, res) => {
  const { id, name, icon, img, price, unit, casePrice, piecesPerCase } = req.body;
  const rawName = sanitizeText(name);
  const rawUnit = sanitizeText(unit);
  const rawIcon = sanitizeText(icon || '📦');
  const rawImg  = sanitizeText(img || '');
  const rawId   = id ? String(id).trim() : '';

  if (rawId && !/^[A-Za-z0-9_-]{1,60}$/.test(rawId))
    return res.status(400).json({ error: 'Product ID may only contain letters, numbers, hyphens, and underscores' });
  if (!rawName || price == null || !rawUnit)
    return res.status(400).json({ error: 'Name, price, and unit are required' });
  if (rawName.length > 120)
    return res.status(400).json({ error: 'Name is too long (max 120 characters)' });
  if (rawUnit.length > 30)
    return res.status(400).json({ error: 'Unit is too long (max 30 characters)' });
  if (rawIcon.length > 4)
    return res.status(400).json({ error: 'Icon value is too long' });
  if (!isSafeImageUrl(rawImg))
    return res.status(400).json({ error: 'Invalid image URL' });
  if (typeof price !== 'number' || price < 0 || price > 10000000)
    return res.status(400).json({ error: 'Price must be a non-negative number' });
  if (casePrice != null && (typeof casePrice !== 'number' || casePrice <= 0 || casePrice > 10000000))
    return res.status(400).json({ error: 'Case price must be a positive number' });
  if (piecesPerCase != null && (!Number.isInteger(piecesPerCase) || piecesPerCase < 1 || piecesPerCase > 10000))
    return res.status(400).json({ error: 'Pieces per case must be a positive integer' });

  try {
    const pid = rawId || 'custom-' + Date.now();
    await pool.query(
      `INSERT INTO products (id, name, icon, img, price, unit, case_price, pieces_per_case, in_stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)`,
      [pid, rawName, rawIcon, rawImg, price, rawUnit, casePrice || null, piecesPerCase || null]
    );

    const { rows: users } = await pool.query(`SELECT id FROM users WHERE role = 'USER'`);
    for (const u of users) {
      await pool.query(
        `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
        [u.id, `New product added: ${rawName}! Check it out in the catalog.`]
      );
    }

    res.status(201).json({ id: pid, message: 'Product created' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Product ID already exists' });
    }
    console.error('[POST /products]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/products/:id — Admin only
router.put('/:id', ...requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { name, img, price, casePrice, piecesPerCase } = req.body;
  const rawName = sanitizeText(name);
  const rawImg  = sanitizeText(img || '');

  if (!rawName || price == null)
    return res.status(400).json({ error: 'Name and price are required' });
  if (rawName.length > 120)
    return res.status(400).json({ error: 'Name is too long (max 120 characters)' });
  if (!isSafeImageUrl(rawImg))
    return res.status(400).json({ error: 'Invalid image URL' });
  if (typeof price !== 'number' || price < 0 || price > 10000000)
    return res.status(400).json({ error: 'Price must be a non-negative number' });
  if (casePrice != null && (typeof casePrice !== 'number' || casePrice <= 0 || casePrice > 10000000))
    return res.status(400).json({ error: 'Case price must be a positive number' });
  if (piecesPerCase != null && (!Number.isInteger(piecesPerCase) || piecesPerCase < 1 || piecesPerCase > 10000))
    return res.status(400).json({ error: 'Pieces per case must be a positive integer' });

  try {
    const { rowCount } = await pool.query(
      `UPDATE products
       SET name = $1, img = $2, price = $3, case_price = $4, pieces_per_case = $5
       WHERE id = $6 AND deleted = false`,
      [rawName, rawImg, price, casePrice || null, piecesPerCase || null, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product updated successfully' });
  } catch (err) {
    console.error('[PUT /products/:id]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PATCH /api/products/:id/stock — Admin only
router.patch('/:id/stock', ...requireRole('ADMIN'), async (req, res) => {
  const { id }      = req.params;
  const { inStock } = req.body;

  if (typeof inStock !== 'boolean')
    return res.status(400).json({ error: 'inStock status must be a boolean' });

  try {
    const { rowCount } = await pool.query(
      `UPDATE products SET in_stock = $1 WHERE id = $2 AND deleted = false`,
      [inStock, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Stock status updated' });
  } catch (err) {
    console.error('[PATCH /products/:id/stock]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/products/:id — Admin only (soft-delete)
router.delete('/:id', ...requireRole('ADMIN'), async (req, res) => {
  const { id } = req.params;
  try {
    const { rowCount } = await pool.query(
      `UPDATE products SET deleted = true WHERE id = $1 AND deleted = false`,
      [id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deleted' });
  } catch (err) {
    console.error('[DELETE /products/:id]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
