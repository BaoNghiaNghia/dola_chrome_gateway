import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (
  process.env.DOLA_FRONTEND_PREBUILT === "1" &&
  existsSync("dist/index.html")
) {
  console.log("[Dola] Frontend already verified and built; skipping duplicate Tauri frontend build.");
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "build"], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
