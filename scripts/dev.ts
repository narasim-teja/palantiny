// One command: builds the sensor if needed, then runs the collector and the console.

export {};

const build = Bun.spawn(["bash", "sensor/build.sh"], { stdout: "inherit", stderr: "inherit" });
if ((await build.exited) !== 0) process.exit(1);

const children = [
  Bun.spawn(["bun", "run", "collector/index.ts"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--bun", "next", "dev", "-H", "127.0.0.1", "-p", "4117"], {
    stdout: "inherit",
    stderr: "inherit",
  }),
];

console.log("palantiny: console at http://127.0.0.1:4117");

function stop(): void {
  for (const child of children) child.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await Promise.race(children.map((child) => child.exited));
stop();
