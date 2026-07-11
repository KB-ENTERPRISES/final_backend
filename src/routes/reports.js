// src/routes/reports.js
const router  = require('express').Router();
const pool    = require('../db/pool');
const ExcelJS = require('exceljs');
const { requireRole } = require('../middleware/auth');

const HEADER_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
const HEADER_FONT  = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
const BODY_FONT    = { name: 'Calibri', size: 10.5 };
const BORDER_THIN  = { style: 'thin', color: { argb: 'FFD9D9D9' } };
const CELL_BORDER  = { top: BORDER_THIN, left: BORDER_THIN, bottom: BORDER_THIN, right: BORDER_THIN };
const CURRENCY_FMT = '₹#,##0.00;[RED]-₹#,##0.00;"-"';
const DATETIME_FMT = 'dd-mmm-yyyy hh:mm AM/PM';

const ROW_FILLS = {
  ASSIGNED:   'FFFFF3CD',
  UNASSIGNED: 'FFFDE2E1',
};

function styleHeaderRow(row) {
  row.eachCell(cell => {
    cell.font      = HEADER_FONT;
    cell.fill      = HEADER_FILL;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border    = CELL_BORDER;
  });
  row.height = 26;
}

function styleBodyRow(row, fillArgb) {
  row.eachCell(cell => {
    cell.font      = BODY_FONT;
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border    = CELL_BORDER;
    if (fillArgb) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } };
  });
}

function setupSheet(wb, name, columns) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  ws.columns = columns;
  styleHeaderRow(ws.getRow(1));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

function avg(arr) { return arr.length ? arr.reduce((s, v) => s + Number(v), 0) / arr.length : 0; }
function round1(n) { return Math.round(n * 10) / 10; }

router.get('/daily', ...requireRole('ADMIN'), async (req, res) => {
  try {
    const istToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const date = String(req.query.date || istToday).trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    const dateStart = `${date} 00:00:00+05:30`;
    const dateEnd   = `${date} 23:59:59+05:30`;

    const [
      ordersRes, itemsRes, auditRes, paymentsRes, signupsRes, notifsRes,
    ] = await Promise.all([
      pool.query(`
        SELECT
          o.id, o.created_at, o.order_type, o.user_name, o.train_no, o.train_name,
          o.stall_name, o.stall_location, o.current_location, o.eta, o.status, o.total,
          o.assigned_crew_id, o.payment_uploaded, o.accepted_at, o.completed_at,
          EXTRACT(EPOCH FROM (o.accepted_at - o.created_at))   AS accept_secs,
          EXTRACT(EPOCH FROM (o.completed_at - o.accepted_at)) AS deliver_secs,
          c.name AS crew_name, u.email AS user_email, u.phone AS user_phone
        FROM orders o
        LEFT JOIN crew c ON c.crew_id = o.assigned_crew_id
        LEFT JOIN users u ON u.id = o.user_id
        WHERE o.created_at BETWEEN $1 AND $2
        ORDER BY o.created_at
      `, [dateStart, dateEnd]),

      pool.query(`
        SELECT oi.order_id, oi.name, oi.qty, oi.price, oi.product_id
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at BETWEEN $1 AND $2
        ORDER BY oi.order_id
      `, [dateStart, dateEnd]),

      pool.query(`
        SELECT event_time, order_id, event, performed_by, note
        FROM audit_logs
        WHERE event_time BETWEEN $1 AND $2
        ORDER BY event_time
      `, [dateStart, dateEnd]),

      pool.query(`
        SELECT p.order_id, p.amount_paid, p.uploaded_by, p.uploaded_at, p.screenshot_data, p.screenshot_mime
        FROM payment_screenshots p
        INNER JOIN orders o ON o.id = p.order_id
        WHERE p.uploaded_at BETWEEN $1 AND $2
        ORDER BY p.uploaded_at
      `, [dateStart, dateEnd]),

      pool.query(`
        SELECT first_name, last_name, email, role, created_at
        FROM users
        WHERE created_at BETWEEN $1 AND $2
        ORDER BY created_at
      `, [dateStart, dateEnd]),

      pool.query(`
        SELECT n.message, n.time, n.read, u.email AS user_email, n.crew_id
        FROM notifications n
        LEFT JOIN users u ON u.id = n.user_id
        WHERE n.time BETWEEN $1 AND $2
        ORDER BY n.time
      `, [dateStart, dateEnd]),
    ]);

    const orders   = ordersRes.rows;
    const items    = itemsRes.rows;
    const audits   = auditRes.rows;
    const payments = paymentsRes.rows;
    const signups  = signupsRes.rows;
    const notifs   = notifsRes.rows;

    const itemsByOrder = {};
    for (const it of items) (itemsByOrder[it.order_id] ??= []).push(it);

    const paymentByOrder = {};
    for (const p of payments) paymentByOrder[p.order_id] = p;

    const auditByOrder = {};
    for (const a of audits) (auditByOrder[a.order_id] ??= []).push(`${a.event} by ${a.performed_by}`);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TrainServe';
    wb.created = new Date();

    // ══════════════════════════════════════════════════════════════
    // SHEET 1 — SUMMARY
    // ══════════════════════════════════════════════════════════════
    const sum = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
    sum.columns = [{ width: 32 }, { width: 22 }];

    sum.mergeCells('A1:B1');
    sum.getCell('A1').value = `TrainServe Daily Report — ${date}`;
    sum.getCell('A1').font  = { name: 'Calibri', bold: true, size: 16, color: { argb: 'FF111827' } };
    sum.getCell('A1').alignment = { horizontal: 'left' };
    sum.getRow(1).height = 30;

    const totalRevenue    = orders.reduce((s, o) => s + Number(o.total || 0), 0);
    const completedCount  = orders.filter(o => o.status === 'COMPLETED').length;
    const pendingCount    = orders.filter(o => o.status === 'PENDING').length;
    const acceptedCount   = orders.filter(o => o.status === 'ACCEPTED').length;
    const avgAcceptMins   = avg(orders.map(o => o.accept_secs).filter(v => v != null)) / 60;
    const avgDeliverMins  = avg(orders.map(o => o.deliver_secs).filter(v => v != null)) / 60;

    const summaryRows = [
      ['Total Orders',                   orders.length],
      ['Completed Orders',               completedCount],
      ['Pending Orders',                 pendingCount],
      ['In Progress Orders',             acceptedCount],
      ['Total Revenue (Rs.)',            totalRevenue],
      ['Avg. Accept Time (mins)',        round1(avgAcceptMins)],
      ['Avg. Delivery Time (mins)',      round1(avgDeliverMins)],
      ['New Signups',                    signups.length],
      ['Payment Screenshots Uploaded',   payments.length],
      ['Audit Events Logged',            audits.length],
      ['Notifications Sent',             notifs.length],
    ];

    let r = 3;
    for (const [label, value] of summaryRows) {
      sum.getCell(`A${r}`).value = label;
      sum.getCell(`A${r}`).font  = { name: 'Calibri', bold: true, size: 11 };
      sum.getCell(`B${r}`).value = value;
      sum.getCell(`B${r}`).font  = { name: 'Calibri', size: 11 };
      sum.getCell(`B${r}`).alignment = { horizontal: 'right' };
      if (label.includes('Rs.')) sum.getCell(`B${r}`).numFmt = CURRENCY_FMT;
      sum.getRow(r).eachCell(c => { c.border = CELL_BORDER; });
      if (r % 2 === 0) sum.getRow(r).eachCell(c => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F7F8' } };
      });
      r++;
    }

    r += 1;
    sum.getCell(`A${r}`).value = 'Row Colour Guide (Orders sheet)';
    sum.getCell(`A${r}`).font  = { bold: true };
    r++;
    const legend = [
      ['Yellow row', 'Order has an assigned crew member'],
      ['Red row',    'Order is still unassigned'],
    ];
    for (const [k, v] of legend) {
      sum.getCell(`A${r}`).value = k;
      sum.getCell(`B${r}`).value = v;
      sum.getCell(`A${r}`).fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: k === 'Yellow row' ? ROW_FILLS.ASSIGNED : ROW_FILLS.UNASSIGNED } };
      r++;
    }

    // ══════════════════════════════════════════════════════════════
    // SHEET 2 — ORDERS
    // Screenshot URLs stored as clickable hyperlinks — no base64 embedding
    // ══════════════════════════════════════════════════════════════
    const ordersWs = setupSheet(wb, 'Orders', [
      { header: 'Order ID',            key: 'orderId',       width: 20 },
      { header: 'Created At',          key: 'createdAt',     width: 20 },
      { header: 'Order Type',          key: 'orderType',     width: 12 },
      { header: 'Customer',            key: 'customer',      width: 20 },
      { header: 'Customer Email',      key: 'email',         width: 26 },
      { header: 'Customer Phone',      key: 'phone',         width: 16 },
      { header: 'Train No',            key: 'trainNo',       width: 10 },
      { header: 'Train Name',          key: 'trainName',     width: 18 },
      { header: 'Stall Name',          key: 'stallName',     width: 18 },
      { header: 'Stall Location',      key: 'stallLoc',      width: 18 },
      { header: 'Current Location',    key: 'location',      width: 18 },
      { header: 'ETA',                 key: 'eta',           width: 12 },
      { header: 'Item Count',          key: 'itemCount',     width: 11 },
      { header: 'Order Total',         key: 'orderTotal',    width: 14 },
      { header: 'Status',              key: 'status',        width: 13 },
      { header: 'Assigned Crew',       key: 'crew',          width: 16 },
      { header: 'Accepted At',         key: 'acceptedAt',    width: 20 },
      { header: 'Completed At',        key: 'completedAt',   width: 20 },
      { header: 'Accept Time (min)',   key: 'acceptMins',    width: 14 },
      { header: 'Delivery Time (min)', key: 'deliverMins',   width: 15 },
      { header: 'Payment Status',      key: 'paymentStatus', width: 14 },
      { header: 'Amount Paid',         key: 'amountPaid',    width: 13 },
      { header: 'Screenshot Link',     key: 'screenshot',    width: 20 },
      { header: 'Events Summary',      key: 'events',        width: 40 },
    ]);

    for (const o of orders) {
      const orderItems = itemsByOrder[o.id] || [];
      const payment    = paymentByOrder[o.id];

      const row = ordersWs.addRow({
        orderId:       o.id,
        createdAt:     o.created_at  ? new Date(o.created_at)  : null,
        orderType:     (o.order_type || 'train').toUpperCase(),
        customer:      o.user_name,
        email:         o.user_email || '',
        phone:         o.user_phone || '',
        trainNo:       o.order_type === 'train' ? o.train_no : '',
        trainName:     o.order_type === 'train' ? o.train_name : '',
        stallName:     o.stall_name     || '',
        stallLoc:      o.stall_location || '',
        location:      o.current_location || '',
        eta:           o.eta || '',
        itemCount:     orderItems.reduce((s, i) => s + i.qty, 0),
        orderTotal:    Number(o.total || 0),
        status:        o.status,
        crew:          o.crew_name || 'Unassigned',
        acceptedAt:    o.accepted_at  ? new Date(o.accepted_at)  : null,
        completedAt:   o.completed_at ? new Date(o.completed_at) : null,
        acceptMins:    o.accept_secs  != null ? round1(o.accept_secs  / 60) : null,
        deliverMins:   o.deliver_secs != null ? round1(o.deliver_secs / 60) : null,
        paymentStatus: o.payment_uploaded ? 'Uploaded' : 'Pending',
        amountPaid:    payment ? Number(payment.amount_paid || 0) : null,
        screenshot:    '',
        events:        (auditByOrder[o.id] || []).join('  |  '),
      });

      const fill = o.crew_name ? ROW_FILLS.ASSIGNED : ROW_FILLS.UNASSIGNED;
      styleBodyRow(row, fill);
      row.getCell('createdAt').numFmt  = DATETIME_FMT;
      row.getCell('acceptedAt').numFmt = DATETIME_FMT;
      row.getCell('completedAt').numFmt = DATETIME_FMT;
      row.getCell('orderTotal').numFmt = CURRENCY_FMT;
      row.getCell('amountPaid').numFmt = CURRENCY_FMT;
      row.height = 20;

      // Store screenshot as clickable hyperlink — no base64 embedding
      if (payment?.screenshot_data) {
        const cell = row.getCell('screenshot');
        cell.value = 'See Payments sheet';
        cell.font  = { ...BODY_FONT, italic: true, color: { argb: 'FF0563C1' } };
      } else if (payment) {
        const cell = row.getCell('screenshot');
        cell.value = 'Expired (31+ days)';
        cell.font  = { ...BODY_FONT, italic: true, color: { argb: 'FF999999' } };
      }
    }

    // ══════════════════════════════════════════════════════════════
    // SHEET 3 — ORDER ITEMS
    // ══════════════════════════════════════════════════════════════
    const itemsWs = setupSheet(wb, 'Order Items', [
      { header: 'Order ID',   key: 'orderId',  width: 20 },
      { header: 'Product',    key: 'name',     width: 26 },
      { header: 'Qty',        key: 'qty',      width: 8  },
      { header: 'Unit Price', key: 'price',    width: 13 },
      { header: 'Subtotal',   key: 'subtotal', width: 13 },
    ]);
    items.forEach((it, idx) => {
      const row = itemsWs.addRow({
        orderId:  it.order_id,
        name:     it.name,
        qty:      it.qty,
        price:    Number(it.price),
        subtotal: Number(it.price) * it.qty,
      });
      styleBodyRow(row, idx % 2 ? 'FFF7F7F8' : null);
      row.getCell('price').numFmt   = CURRENCY_FMT;
      row.getCell('subtotal').numFmt = CURRENCY_FMT;
    });

    // ══════════════════════════════════════════════════════════════
    // SHEET 4 — AUDIT LOG
    // ══════════════════════════════════════════════════════════════
    const auditWs = setupSheet(wb, 'Audit Log', [
      { header: 'Timestamp',    key: 'time',    width: 20 },
      { header: 'Order ID',     key: 'orderId', width: 20 },
      { header: 'Event',        key: 'event',   width: 22 },
      { header: 'Performed By', key: 'by',      width: 18 },
      { header: 'Note',         key: 'note',    width: 40 },
    ]);
    audits.forEach((a, idx) => {
      const row = auditWs.addRow({
        time:    a.event_time ? new Date(a.event_time) : null,
        orderId: a.order_id,
        event:   a.event,
        by:      a.performed_by,
        note:    a.note || '',
      });
      styleBodyRow(row, idx % 2 ? 'FFF7F7F8' : null);
      row.getCell('time').numFmt = DATETIME_FMT;
    });

    // ══════════════════════════════════════════════════════════════
    // SHEET 5 — PAYMENTS
    // ══════════════════════════════════════════════════════════════
    const payWs = setupSheet(wb, 'Payments', [
      { header: 'Order ID',       key: 'orderId', width: 20 },
      { header: 'Uploaded At',    key: 'time',    width: 20 },
      { header: 'Uploaded By',    key: 'by',      width: 16 },
      { header: 'Amount Paid',    key: 'amount',  width: 14 },
      { header: 'Screenshot',     key: 'shot',    width: 22 },
    ]);
    payments.forEach((p, idx) => {
      const row = payWs.addRow({
        orderId: p.order_id,
        time:    p.uploaded_at ? new Date(p.uploaded_at) : null,
        by:      p.uploaded_by,
        amount:  Number(p.amount_paid || 0),
        shot:    '',
      });
      styleBodyRow(row, idx % 2 ? 'FFF7F7F8' : null);
      row.getCell('time').numFmt   = DATETIME_FMT;
      row.getCell('amount').numFmt = CURRENCY_FMT;

      if (p.screenshot_data) {
        const ext = (p.screenshot_mime || 'image/jpeg').includes('png') ? 'png' : 'jpeg';
        const imageId = wb.addImage({ buffer: p.screenshot_data, extension: ext });
        payWs.addImage(imageId, {
          tl: { col: 4, row: row.number - 1 },
          ext: { width: 120, height: 90 },
          editAs: 'oneCell',
        });
        row.height = 70;
      } else {
        row.getCell('shot').value = 'Expired (31+ days)';
        row.getCell('shot').font  = { ...BODY_FONT, italic: true, color: { argb: 'FF999999' } };
      }
    });

    // ══════════════════════════════════════════════════════════════
    // SHEET 6 — SIGNUPS
    // ══════════════════════════════════════════════════════════════
    const signupWs = setupSheet(wb, 'Signups', [
      { header: 'Created At', key: 'time',  width: 20 },
      { header: 'First Name', key: 'first', width: 16 },
      { header: 'Last Name',  key: 'last',  width: 16 },
      { header: 'Email',      key: 'email', width: 28 },
      { header: 'Phone',      key: 'phone', width: 16 },
      { header: 'Role',       key: 'role',  width: 12 },
    ]);
    signups.forEach((u, idx) => {
      const row = signupWs.addRow({
        time:  u.created_at ? new Date(u.created_at) : null,
        first: u.first_name,
        last:  u.last_name,
        email: u.email,
        phone: u.phone || '',
        role:  u.role,
      });
      styleBodyRow(row, idx % 2 ? 'FFF7F7F8' : null);
      row.getCell('time').numFmt = DATETIME_FMT;
    });

    // ══════════════════════════════════════════════════════════════
    // SHEET 7 — NOTIFICATIONS
    // ══════════════════════════════════════════════════════════════
    const notifWs = setupSheet(wb, 'Notifications', [
      { header: 'Time',       key: 'time',  width: 20 },
      { header: 'User Email', key: 'email', width: 26 },
      { header: 'Crew ID',    key: 'crew',  width: 12 },
      { header: 'Message',    key: 'msg',   width: 45 },
      { header: 'Read',       key: 'read',  width: 10 },
    ]);
    notifs.forEach((n, idx) => {
      const row = notifWs.addRow({
        time:  n.time ? new Date(n.time) : null,
        email: n.user_email || '',
        crew:  n.crew_id    || '',
        msg:   n.message,
        read:  n.read ? 'Yes' : 'No',
      });
      styleBodyRow(row, idx % 2 ? 'FFF7F7F8' : null);
      row.getCell('time').numFmt = DATETIME_FMT;
    });

    // ── Stream response ──────────────────────────────────────────────
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="TrainServe-${date}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Report error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong generating the report.' });
    }
  }
});

// GET /api/reports/daily-json - Admin Only (returns daily report details as JSON)
router.get('/daily-json', ...requireRole('ADMIN'), async (req, res) => {
  try {
    const istToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const date = String(req.query.date || istToday).trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    const dateStart = `${date} 00:00:00+05:30`;
    const dateEnd   = `${date} 23:59:59+05:30`;

    const [
      ordersRes, itemsRes, signupsRes, productsRes
    ] = await Promise.all([
      pool.query(`
        SELECT
          o.id, o.created_at, o.order_type, o.user_name, o.train_no, o.train_name,
          o.stall_name, o.stall_location, o.current_location, o.eta, o.status, o.total,
          o.assigned_crew_id, c.name AS crew_name, u.phone AS user_phone
        FROM orders o
        LEFT JOIN crew c ON c.crew_id = o.assigned_crew_id
        LEFT JOIN users u ON u.id = o.user_id
        WHERE o.created_at BETWEEN $1 AND $2
        ORDER BY o.created_at
      `, [dateStart, dateEnd]),

      pool.query(`
        SELECT oi.order_id, oi.product_id, oi.name, oi.qty, oi.price
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE o.created_at BETWEEN $1 AND $2
      `, [dateStart, dateEnd]),

      pool.query(`
        SELECT first_name, last_name, email, phone, role, created_at
        FROM users
        WHERE created_at BETWEEN $1 AND $2
        ORDER BY created_at
      `, [dateStart, dateEnd]),

      pool.query(`
        SELECT id, name, price, created_at
        FROM products
        WHERE created_at BETWEEN $1 AND $2 AND deleted = false
        ORDER BY created_at
      `, [dateStart, dateEnd]),
    ]);

    const orders = ordersRes.rows;
    const items = itemsRes.rows;
    const signups = signupsRes.rows;
    const productsCreated = productsRes.rows;

    const itemsByOrder = {};
    for (const it of items) {
      (itemsByOrder[it.order_id] ??= []).push(it);
    }

    const productsOrderedMap = {};
    for (const it of items) {
      if (!productsOrderedMap[it.product_id]) {
        productsOrderedMap[it.product_id] = { name: it.name, qty: 0, revenue: 0 };
      }
      productsOrderedMap[it.product_id].qty += it.qty;
      productsOrderedMap[it.product_id].revenue += it.qty * it.price;
    }
    const productsOrdered = Object.entries(productsOrderedMap).map(([id, info]) => ({
      id,
      name: info.name,
      qty: info.qty,
      revenue: info.revenue
    }));

    const totalRevenue = orders.reduce((s, o) => s + Number(o.total || 0), 0);

    res.json({
      date,
      totalRevenue,
      totalOrders: orders.length,
      orders: orders.map(o => ({
        ...o,
        items: itemsByOrder[o.id] || []
      })),
      newSignups: signups,
      productsCreated,
      productsOrdered
    });
  } catch (err) {
    console.error('JSON report error:', err);
    res.status(500).json({ error: 'Failed to generate report JSON' });
  }
});

module.exports = router;
