// One command for development: builds the sensor if needed, then runs the server and
// the console. Vite serves the console on 4117 and forwards /v1 to the server.

export {};

if (process.platform === "darwin") {
  const build = Bun.spawn(["bash", "native/macos/build.sh"], { stdout: "inherit", stderr: "inherit" });
  if ((await build.exited) !== 0) process.exit(1);
}

const children = [
  Bun.spawn(["bun", "run", "server/index.ts"], {
    // Both spellings reach Vite, and the browser sends whichever is in the address bar.
    env: {
      ...process.env,
      PALANTINY_PORT: "4118",
      PALANTINY_WEB_ORIGINS: "http://127.0.0.1:4117,http://localhost:4117",
    },
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", "--bun", "vite", "--config", "web/vite.config.ts"], { stdout: "inherit", stderr: "inherit" }),
];

console.log("palantiny: console at http://127.0.0.1:4117");

function stop(): void {
  for (const child of children) child.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await Promise.race(children.map((child) => child.exited));
stop();
