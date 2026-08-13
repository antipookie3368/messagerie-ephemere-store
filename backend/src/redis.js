import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';

export const redis = new Redis(redisUrl);

// Separate connection dedicated to keyspace-notification subscriptions
// (a Redis connection in subscribe mode can't run normal commands).
export const redisSub = new Redis(redisUrl);

export async function enableExpiryNotifications() {
  await redis.config('SET', 'notify-keyspace-events', 'Ex');
}
