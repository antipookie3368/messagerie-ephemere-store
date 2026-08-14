import crypto from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';

const genToken = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 48);
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 jours

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function checkAdminPassword(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof password !== 'string') return false;
  return timingSafeEqual(password, expected);
}

export async function createAdminSession() {
  const token = genToken();
  await redis.set(`admin_session:${token}`, '1', 'EX', ADMIN_SESSION_TTL_SECONDS);
  return token;
}

export async function isAdminSession(token) {
  if (!token) return false;
  const value = await redis.get(`admin_session:${token}`);
  return value === '1';
}

export async function requireAdmin(request, reply) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const ok = await isAdminSession(token);
  if (!ok) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}
