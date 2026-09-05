import { createStrictSession } from '../../plugins/sol-advisor/control-plane/lib/execution/codex-session.mjs';

process.once('message', async options => {
  try {
    const session = await createStrictSession(options);
    process.send({ home: session.profile.home });
    // The qualification controller deliberately terminates this owner. Do not
    // make the fixture falsely pass by running graceful session.close().
  } catch (error) { process.send({ error: error.message }); process.exitCode = 1; process.disconnect(); }
});
