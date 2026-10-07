import { startServer } from "./server.js";

startServer()
  .then((s) => {
    console.log(JSON.stringify({ msg: "listening", port: s.port }));
    const shutdown = (): void => {
      void s.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((err) => {
    console.error(JSON.stringify({ msg: "fatal", err: String(err) }));
    process.exit(1);
  });
