import { join } from "node:path";

const rootDir = process.cwd();

setDefault("NODE_ENV", "development");
setDefault("HOST", "127.0.0.1");
setDefault("PORT", "3000");
setDefault("CONFIG_DIR", join(rootDir, ".local", "dev-config"));
setDefault("DOWNLOADS_DIR", join(rootDir, "data", "downloads"));
setDefault("ADMIN_PASSWORD", "admin");
setDefault("LOG_LEVEL", "info");

console.log("Starting dev server with local defaults:");
console.log(`  URL: http://${process.env.HOST}:${process.env.PORT}`);
console.log(`  CONFIG_DIR: ${process.env.CONFIG_DIR}`);
console.log(`  DOWNLOADS_DIR: ${process.env.DOWNLOADS_DIR}`);
console.log("  ADMIN_PASSWORD: admin");

await import("./main.js");

function setDefault(name: string, value: string): void {
  process.env[name] ??= value;
}
