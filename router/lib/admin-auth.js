'use strict';

function getAdminToken() {
  const t = process.env.ROUTER_ADMIN_TOKEN;
  if (t === undefined || t === null) return '';
  return String(t).trim();
}

function isAuthorized(req) {
  const token = getAdminToken();
  if (!token) return true;
  const auth = req.headers.authorization;
  const x = req.headers['x-router-token'];
  if (auth === `Bearer ${token}`) return true;
  if (x === token) return true;
  return false;
}

function sendUnauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'unauthorized',
    hint: 'Send X-Router-Token or Authorization: Bearer <ROUTER_ADMIN_TOKEN>',
  }));
}

function requireAdmin(req, res) {
  if (isAuthorized(req)) return true;
  sendUnauthorized(res);
  return false;
}

module.exports = { getAdminToken, isAuthorized, requireAdmin };
