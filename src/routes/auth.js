import Router from 'koa-router';
import rp from 'request-promise-native';
import validator, { object, string } from 'koa-context-validator';
import { initSession } from '../sessions';
import config from '../config';
import provider from '../models/provider';
import refreshToken from '../models/refreshToken';
import { fetchProfile } from '../profile';
import { sign } from '../jwt';

const router = Router({
  prefix: '/auth',
});

const providersConfig = {
  github: config.github,
  google: config.google,
};

Object.keys(providersConfig).forEach((providerName) => {
  const providerConfig = providersConfig[providerName];
  const redirectUri = `${config.urlPrefix}/v1/auth/${providerName}/callback`;

  router.get(
    `/${providerName}/authorize`,
    validator({
      query: {
        redirect_uri: string().required(),
      },
    }),
    async (ctx) => {
      const { query } = ctx.request;
      const url = `${providerConfig.authorizeUrl}?access_type=offline&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${providerConfig.clientId}&scope=${encodeURIComponent(providerConfig.scope)}&state=${encodeURIComponent(query.redirect_uri)}`;

      ctx.status = 307;
      ctx.redirect(url);
    },
  );

  router.get(`/${providerName}/callback`, async (ctx) => {
    const { query } = ctx.request;
    ctx.status = 307;
    ctx.redirect(`${query.state}?code=${query.code}`);
  });

  router.post(
    `/${providerName}/authenticate`,
    validator({
      body: object().keys({
        code: string().required(),
      }),
    }, {
      stripUnknown: true,
    }),
    async (ctx) => {
      const { body } = ctx.request;
      const resRaw = await rp({
        url: providerConfig.authenticateUrl,
        method: 'POST',
        headers: {
          accept: 'application/json',
        },
        form: {
          client_id: providerConfig.clientId,
          client_secret: providerConfig.clientSecret,
          code: body.code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        },
      });

      const res = (typeof resRaw === 'string') ? JSON.parse(resRaw) : resRaw;

      if (!res.access_token) {
        ctx.status = 403;
        return;
      }

      const profile = await fetchProfile(providerName, res.access_token);
      const userProvider = await provider.getByProviderId(profile.id, providerName);

      let newUser = true;
      if (userProvider) {
        ctx.session.userId = userProvider.userId;
        newUser = false;
        await provider.updateToken(ctx.session.userId, providerName, res.access_token);
      } else {
        initSession(ctx);
        await provider.add(
          ctx.session.userId, providerName, res.access_token, profile.id,
          res.expires_in ? (new Date(Date.now() + (res.expires_in * 1000))) : null,
          res.refresh_token,
        );
      }

      const accessToken = await sign({ userId: ctx.session.userId });
      const rfToken = refreshToken.generate(ctx.session.userId);
      await refreshToken.add(ctx.session.userId, rfToken);

      ctx.log.info(`connected ${ctx.session.userId} with ${providerName}`);

      ctx.status = 200;
      ctx.body = {
        id: ctx.session.userId,
        providers: [providerName],
        name: profile.name,
        image: profile.image,
        newUser,
        accessToken: accessToken.token,
        expiresIn: accessToken.expiresIn,
        refreshToken: rfToken,
      };
    },
  );
});

router.post(
  '/refresh',
  validator({
    body: object().keys({
      refreshToken: string().required(),
    }),
  }, {
    stripUnknown: true,
  }),
  async (ctx) => {
    const { body } = ctx.request;
    const model = await refreshToken.getByToken(body.refreshToken);

    if (!model) {
      ctx.status = 403;
      return;
    }

    ctx.log.info(`refreshed token for ${model.userId}`);

    const accessToken = await sign({ userId: ctx.session.userId });
    ctx.status = 200;
    ctx.body = accessToken;
  },
);

export default router;
