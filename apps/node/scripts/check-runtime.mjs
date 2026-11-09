// Plain JavaScript on purpose: it must run, and explain itself, on runtimes too old to load the TypeScript sources.
// The node runs .ts files directly with Node's built-in type stripping, which is on by default from 22.18 and 23.6.
const [major, minor] = process.versions.node.split(".").map(Number);
const ok = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
if (!ok) {
  process.stderr.write(
    `Payminto needs Node.js 22.18 or newer (found ${process.versions.node}).\n` +
      "It runs TypeScript directly with Node's built-in type stripping and uses node:sqlite.\n" +
      "Install it with nvm (`nvm install` reads .nvmrc) or use the Docker image (docs/DEPLOY.md).\n",
  );
  process.exit(1);
}
