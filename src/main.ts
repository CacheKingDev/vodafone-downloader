import { createApplication } from "./composition-root.js";

async function main(): Promise<void> {
  const application = await createApplication();

  const stop = (signal: string): void => {
    application.logger.info({ signal }, "shutting down");
    application.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        application.logger.error({ err: error }, "shutdown failed");
        process.exit(1);
      },
    );
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  await application.app.listen({
    host: application.config.host,
    port: application.config.port,
  });

  application.scheduler.start();
  application.logger.info({ nextRun: application.scheduler.nextSyncRun() }, "scheduler active");
}

main().catch((error: unknown) => {
  // The logger may not exist yet — this is the last resort.
  console.error("Startup failed:", error);
  process.exit(1);
});
