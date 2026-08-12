/** Boots the mock command center, runs the browser smoke test against the real
 *  public/index.html, and tears the server down whichever way it ends. */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const port = process.env.UI_MOCK_PORT ?? "4173";

const server = spawn(process.execPath, [resolve(here, "mock-server.mjs"), resolve(root, "public")], {
  stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, UI_MOCK_PORT: port },
});
const ready = new Promise((ok, fail) => {
  server.stdout.on("data", (d) => String(d).includes("mock command center") && ok());
  server.on("exit", (c) => fail(new Error(`mock server exited early (${c})`)));
  setTimeout(() => fail(new Error("mock server did not start within 15s")), 15_000);
});

let code = 1;
try {
  await ready;
  code = await new Promise((ok) =>
    spawn(process.execPath, [resolve(here, "smoke.mjs")], { stdio: "inherit", env: { ...process.env, UI_MOCK_PORT: port } })
      .on("exit", (c) => ok(c ?? 1)));
} catch (err) {
  console.error(err.message);
} finally {
  server.kill();
}
process.exit(code);
