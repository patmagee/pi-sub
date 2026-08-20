import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Verifies that a private Unix domain socket can be created, authenticated,
// and exchanged over inside the current sandbox. Run it under nono to confirm
// the subagent control socket has the local access it needs.

const CHILD_MARKER = "PI_SUB_SOCKET_SMOKE_CHILD";

async function runParent() {
  const parentDirectory = process.env.PI_SUB_SOCKET_DIR ?? tmpdir();
  const socketDirectory = await mkdtemp(join(parentDirectory, "pi-sub-smoke-"));
  const socketPath = join(socketDirectory, "control.sock");
  const token = randomBytes(32).toString("hex");

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.type === "hello" && message.token === token) {
        socket.write(`${JSON.stringify({ type: "welcome" })}\n`);
      } else {
        socket.write(`${JSON.stringify({ type: "rejected" })}\n`);
      }
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const scriptPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, [CHILD_MARKER]: "1", PI_SUB_SMOKE_SOCKET: socketPath, PI_SUB_SMOKE_TOKEN: token },
      stdio: ["ignore", "pipe", "inherit"],
    });

    let childOutput = "";
    child.stdout.on("data", (chunk) => {
      childOutput += chunk.toString("utf8");
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    if (code !== 0 || !childOutput.includes("welcome")) {
      throw new Error(`socket smoke test failed: exit ${code}, output ${JSON.stringify(childOutput)}`);
    }
    console.log("socket smoke test passed");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(socketDirectory, { recursive: true, force: true });
  }
}

function runChild() {
  return new Promise((resolve, reject) => {
    const socket = createConnection(process.env.PI_SUB_SMOKE_SOCKET);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "hello", token: process.env.PI_SUB_SMOKE_TOKEN })}\n`);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      process.stdout.write(message.type);
      socket.end();
      resolve();
    });
  });
}

if (process.env[CHILD_MARKER] === "1") {
  await runChild();
} else {
  await runParent();
}
