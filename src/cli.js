#!/usr/bin/env node
const { createAgentServer } = require('./server');

async function main() {
  const agent = createAgentServer();
  await agent.start();

  const shutdown = async () => {
    await agent.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
