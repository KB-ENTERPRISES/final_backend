// src/utils/sanitize.js
// Shared text sanitization — strips angle brackets, ampersands, and quotes
// to prevent XSS when values are reflected in notifications or responses.

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[<>&"']/g, '');
}

module.exports = { sanitizeText };
