import { mobileFixture, fixtureCredentials } from './fixtures/mobile-desktop.mjs';

const fixture = await mobileFixture({ port: Number(process.env.STARPORT_MOBILE_UI_PORT || 0), interval: 500 });
console.log(JSON.stringify({ app: fixture.hub.origin() + '/remote/', ...fixtureCredentials }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await fixture.close();
  process.exit(0);
});
