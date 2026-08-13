import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const genToken = customAlphabet(alphabet, 40);

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 jours
const PSEUDO_REGEX = /^[a-zA-Z0-9_-]{3,24}$/;

export function isValidPseudo(pseudo) {
  return typeof pseudo === 'string' && PSEUDO_REGEX.test(pseudo);
}

export async function createSession(pseudo) {
  const token = genToken();
  await redis.set(`session:${token}`, pseudo, 'EX', SESSION_TTL_SECONDS);
  return token;
}

export async function getPseudoFromToken(token) {
  if (!token) return null;
  return redis.get(`session:${token}`);
}

export async function requireAuth(request, reply) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const pseudo = await getPseudoFromToken(token);
  if (!pseudo) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  request.pseudo = pseudo;
  request.sessionToken = token;
  return pseudo;
}
