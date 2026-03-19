// ─────────────────────────────────────────────
// test/integration/run.ts — 集成测试编排器
// 运行方式：npx tsx test/integration/run.ts
// ─────────────────────────────────────────────

import { spawn, ChildProcess } from "child_process";
import { fileURLToPath }       from "url";
import { dirname, join }       from "path";
import http                    from "http";
import { readdirSync, rmSync } from "fs";
import { tmpdir }              from "os";

const __dir    = dirname(fileURLToPath(import.meta.url));
const ROOT     = join(__dir, "..", "..");
const TSX      = join(ROOT, "node_modules", ".bin", "tsx");
// 每次测试用随机端口，避免旧数据和端口冲突
const RELAY_PORT = 9700 + Math.floor(Math.random() * 200);
const RELAY_URL  = `http://localhost:${RELAY_PORT}/gun`;

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GRAY   = "\x1b[90m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";

function pass(label: string, ms: number) {
  console.log(`  ${GREEN}✓${RESET} ${label.padEnd(48)}${GRAY}[${ms}ms]${RESET}`);
}
function fail(label: string, reason: string) {
  console.log(`  ${RED}✗${RESET} ${label.padEnd(48)}${RED}${reason}${RESET}`);
}
function info(msg: string) {
  console.log(`    ${YELLOW}→${RESET} ${GRAY}${msg}${RESET}`);
}
function section(title: string) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

function waitForLine(proc: ChildProcess, prefix: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`等待 "${prefix}" 超时 (${timeout}ms)`)),
      timeout
    );

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const t = line.trim();
        if (t.startsWith(prefix)) {
          clearTimeout(timer);
          proc.stdout?.off("data", onData);
          resolve(t);
          return;
        }
      }
    };

    proc.stdout?.on("data", onData);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`进程以退出码 ${code} 结束`));
    });
  });
}

function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, (res) => {
        if (res.statusCode === 200) { resolve(); return; }
        retry();
      }).on("error", retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error(`健康检查超时: ${url}`));
      else setTimeout(attempt, 150);
    };
    attempt();
  });
}

function spawnNode(script: string, env: Record<string, string> = {}): ChildProcess {
  const proc = spawn(TSX, [script], {
    env:   { ...process.env, ...env },
    cwd:   ROOT,
    stdio: ["pipe", "pipe", "pipe"],  // stdin pipe 用于发送命令
  });
  const name = script.split("/").pop()?.replace(".ts", "") ?? "node";
  proc.stderr?.on("data", (buf: Buffer) => {
    for (const line of buf.toString().split("\n").filter(Boolean)) {
      if (
        line.includes("wonderful person") || line.includes("AXE relay") ||
        line.includes("Multicast on")     || line.includes("Warning: reusing") ||
        line.includes("[identity]")       || line.includes("[profile]") ||
        line.includes("[config]")         || line.includes("[network]") ||
        line.includes("[webrtc-polyfill]")
      ) continue;
      process.stderr.write(`${GRAY}[${name}]${RESET} ${line}\n`);
    }
  });
  return proc;
}

function killAll(procs: ChildProcess[]) {
  procs.forEach((p) => { try { p.kill("SIGTERM"); } catch { /* */ } });
}

interface Result { label: string; passed: boolean; ms: number; reason?: string; }
const results: Result[] = [];

async function step(label: string, fn: () => Promise<void>, timeout = 10_000): Promise<boolean> {
  const t0 = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<void>((_, r) => setTimeout(() => r(new Error(`步骤超时 (${timeout}ms)`)), timeout)),
    ]);
    const ms = Date.now() - t0;
    pass(label, ms);
    results.push({ label, passed: true, ms });
    return true;
  } catch (e) {
    const ms     = Date.now() - t0;
    const reason = e instanceof Error ? e.message : String(e);
    fail(label, reason);
    results.push({ label, passed: false, ms, reason });
    return false;
  }
}

async function main() {
  console.log(`\n${BOLD}P2P Jobs — 集成测试套件${RESET}`);
  console.log("─".repeat(62));

  const procs: ChildProcess[] = [];
  let nodeAId = "";

  // ── 清理旧临时目录，避免 Gun 残留数据和端口冲突 ──────────────────────
  const tmp = tmpdir();
  try {
    for (const entry of readdirSync(tmp)) {
      if (entry.startsWith("monadx-")) {
        try { rmSync(join(tmp, entry), { recursive: true, force: true }); } catch { /* */ }
      }
    }
    info("已清理旧临时目录");
  } catch { /* */ }

  const cleanup = () => { killAll(procs); process.exit(0); };
  process.on("SIGINT",  cleanup);
  process.on("SIGTERM", cleanup);

  try {
    // ── Phase 1: 中继 ──────────────────────────────────────────────────
    section("Phase 1  Gun.js 中继服务");

    let relayProc!: ChildProcess;
    if (!await step("启动本地 HTTP 中继 (port 9765)", async () => {
      relayProc = spawnNode(join(__dir, "relay.ts"), { monadx_RELAY_PORT: String(RELAY_PORT) });
      procs.push(relayProc);
      await waitForLine(relayProc, "RELAY_READY:", 5_000);
    })) throw new Error("中继启动失败");

    await step("中继健康检查 /health", async () => {
      await waitForHttp(`http://localhost:${RELAY_PORT}/health`, 5_000);
    });

    // ── Phase 2: 节点启动 ──────────────────────────────────────────────
    section("Phase 2  节点启动 & Profile 广播");

    let nodeA!: ChildProcess;
    let nodeB!: ChildProcess;

    if (!await step("node_a (求职者) 启动 — 广播简历摘要", async () => {
      nodeA = spawnNode(join(__dir, "node_a.ts"), { RELAY_URL });
      procs.push(nodeA);
      const line = await waitForLine(nodeA, "READY:", 8_000);
      nodeAId = line.replace("READY:", "").trim();
      info(`node_a 节点 ID: ${nodeAId.slice(0, 24)}…`);
    }, 10_000)) throw new Error("node_a 启动失败");

    if (!await step("node_b (招聘方) 启动 — 广播 JD 摘要", async () => {
      nodeB = spawnNode(join(__dir, "node_b.ts"), { RELAY_URL, TARGET_NODE: nodeAId });
      procs.push(nodeB);
      const line = await waitForLine(nodeB, "READY:", 8_000);
      info(`node_b 节点 ID: ${line.replace("READY:", "").trim().slice(0, 24)}…`);
    }, 10_000)) throw new Error("node_b 启动失败");

    // ── Phase 3+4: 发现 + 匹配 ──────────────────────────────────────────
    section("Phase 3  P2P 发现 + Phase 4  本地匹配");

    await step("node_b 拉取 node_a profile 并完成匹配", async () => {
      // 关键：先建立所有监听，再触发 FETCH，避免输出丢失
      const listenDiscovered = waitForLine(nodeB, "DISCOVERED:", 12_000);
      const listenScore      = waitForLine(nodeB, "MATCH_SCORE:", 12_000);
      const listenProposed   = waitForLine(nodeB, "PROPOSED:",   12_000);

      // 发送 FETCH 命令给 node_b
      await new Promise<void>((resolve, reject) => {
        nodeB.stdin?.write(`FETCH:${nodeAId}\n`, (err) => {
          if (err) reject(err); else resolve();
        });
      });

      const [discLine, scoreLine, propLine] =
        await Promise.all([listenDiscovered, listenScore, listenProposed]);

      const id    = discLine.replace("DISCOVERED:", "").trim();
      const score = parseInt(scoreLine.replace("MATCH_SCORE:", "").trim());
      const prop  = propLine.replace("PROPOSED:", "").trim();

      info(`发现: ${id.slice(0,20)}…  分数: ${score}/100  propose→${prop.slice(0,16)}…`);

      if (!nodeAId.startsWith(id.slice(0, 8)))
        throw new Error(`发现预期外节点: ${id.slice(0,16)}`);
      if (isNaN(score) || score < 20)
        throw new Error(`分数不足: ${score}`);
    }, 18_000);

    // ── Phase 5: 意向握手 ──────────────────────────────────────────────
    section("Phase 5  加密意向握手（Ed25519 签名）");

    await step("node_a 收到 propose 并发送 accept", async () => {
      const [intentLine, acceptLine] = await Promise.all([
        waitForLine(nodeA, "INTENT_RECEIVED", 10_000),
        waitForLine(nodeA, "ACCEPTED",        12_000),
      ]);
      if (!intentLine || !acceptLine) throw new Error("握手信号缺失");
    }, 15_000);

    // ── Phase 6 + 8 + 9: TCP 直连 → 文档交换 → IM 绑定 ────────────────
    // 这三个事件几乎同时发生（毫秒级），必须在 CONNECTED 之前就注册所有监听器
    section("Phase 6  TCP 直连 + Phase 8 文档交换 + Phase 9 IM 绑定");

    // 先注册所有监听器
    const listenConnA = waitForLine(nodeA, "CONNECTED", 15_000);
    const listenConnB = waitForLine(nodeB, "CONNECTED", 15_000);
    const listenDocA  = waitForLine(nodeA, "DOC_RECEIVED:", 20_000);
    const listenDocB  = waitForLine(nodeB, "DOC_RECEIVED:", 20_000);
    const listenIMA   = waitForLine(nodeA, "IM_BIND:", 20_000);
    const listenIMB   = waitForLine(nodeB, "IM_BIND:", 20_000);

    await step("双端建立 TCP 直连", async () => {
      const [connA, connB] = await Promise.all([listenConnA, listenConnB]);
      if (!connA || !connB) throw new Error("至少一端未建立连接");
    }, 18_000);

    await step("双端互换完整文档", async () => {
      const [lineA, lineB] = await Promise.all([listenDocA, listenDocB]);
      const charsA = parseInt(lineA.replace("DOC_RECEIVED:", "").trim());
      const charsB = parseInt(lineB.replace("DOC_RECEIVED:", "").trim());
      info(`node_a 收到: ${charsB} 字符  node_b 收到: ${charsA} 字符`);
      if (charsA < 50) throw new Error(`node_a 文档过短: ${charsA}`);
      if (charsB < 50) throw new Error(`node_b 文档过短: ${charsB}`);
    }, 22_000);

    await step("文档交换后自动创建 IM 通道", async () => {
      const bindLine = await Promise.race([listenIMA, listenIMB]);
      const channelId = bindLine.replace("IM_BIND:", "").trim();
      if (!channelId || channelId.length < 10) throw new Error(`IM channel ID 无效: ${channelId}`);
      info(`IM 通道: ${channelId}`);
    }, 22_000);


  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`\n  ${RED}✗ 测试提前终止: ${msg}${RESET}`);
  } finally {
    killAll(procs);
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────
  const total  = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;

  console.log(`\n${"─".repeat(62)}`);
  console.log(`${BOLD}测试结果${RESET}`);
  console.log(
    `  通过 ${GREEN}${passed}${RESET}  ` +
    `失败 ${failed > 0 ? RED : GRAY}${failed}${RESET}  ` +
    `共 ${total} 步\n`
  );

  if (failed > 0) {
    console.log(`  ${RED}失败步骤:${RESET}`);
    results.filter(r => !r.passed).forEach(r => {
      console.log(`    ${RED}✗${RESET} ${r.label}`);
      console.log(`      ${GRAY}原因: ${r.reason}${RESET}`);
    });
    console.log();
  }

  const ok = failed === 0;
  console.log(`  ${ok ? GREEN + "✓ 全部通过" : RED + "✗ 存在失败项"} ${RESET}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(RED + "未预期错误:" + RESET, e);
  process.exit(1);
});
