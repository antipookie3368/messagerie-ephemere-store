import { checkAdminPassword, createAdminSession } from '../adminAuth.js';

export default async function adminAuthRoutes(fastify) {
  fastify.post(
    '/api/admin/login',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { password } = request.body || {};
      if (!checkAdminPassword(password)) {
        return reply.code(401).send({ error: 'invalid_password' });
      }
      const adminSessionToken = await createAdminSession();
      return reply.send({ adminSessionToken });
    }
  );
}
