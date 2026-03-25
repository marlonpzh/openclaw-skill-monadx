// ─────────────────────────────────────────────
// scheduler.ts — 智能广播调度（Smart Broadcast Scheduler）
//
// 拥有三挡广播频率：
// 1. 热启动（hot start）：进程启动时，或简历有修改时。维持短短几次高频广播。
// 2. 稳态（steady）：活跃时段内，定期（如每 4 小时）保持存活。
// 3. 休眠（sleep）：非活跃时段（如半夜），拉长间隔甚至暂停，节约资源。
// ─────────────────────────────────────────────

import type { SkillConfig }  from "./config.js";
import type { KeyPair }      from "./identity.js";
import type { LocalProfile } from "./types.js";
import { buildProfile, toBroadcast } from "./profile.js";
import type { P2PNetwork }   from "./network.js";

interface SchedulerDeps {
  cfg:       SkillConfig;
  dataDir:   string;
  role:      "seeker" | "employer";
  keyPair:   KeyPair;
  network:   P2PNetwork;
}

export class BroadcastScheduler {
  private deps:          SchedulerDeps;
  private timer:         ReturnType<typeof setTimeout> | null = null;
  private lastDocHash:   string = "";
  
  // 热启动剩余次数
  private hotStartRemaining: number;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.hotStartRemaining = deps.cfg.broadcast.hot_start_count;
  }

  /** 开始智能调度循环 */
  start(): void {
    if (this.timer) return;
    this.scheduleNext(3000); // Wait 3s for Gun.js WebSockets to stabilize before first broadcast
  }

  /** 停止调度循环 */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.executeBroadcast();
    }, delayMs);
    // don't keep the Node.js process alive solely for this timer
    // unless the process wants to stay alive anyway
    this.timer.unref();
  }

  private executeBroadcast(): void {
    const { cfg, dataDir, role, keyPair, network } = this.deps;
    
    // 构建最新的 profile
    let profile: LocalProfile;
    try {
      profile = buildProfile(dataDir, role, keyPair);
    } catch (e) {
      console.warn("[scheduler] 广播失败，构建 profile 时出错:", e);
      // 即便错了也继续重试
      this.scheduleNext(cfg.broadcast.steady_interval_sec * 1000);
      return;
    }

    // 检查是否发生内容变更
    if (profile.doc_hash !== this.lastDocHash) {
      this.lastDocHash = profile.doc_hash;
      // 内容变更，重置热启动计数
      this.hotStartRemaining = cfg.broadcast.hot_start_count;
      console.log("[scheduler] 文档有更新，进入热启动广播模式");
    }

    // 发送广播
    network.broadcast(toBroadcast(profile));

    // 计算下一次广播的间隔
    const nextMs = this.calculateNextDelay(cfg);
    this.scheduleNext(nextMs);
  }

  private calculateNextDelay(cfg: SkillConfig): number {
    const hour = new Date().getHours();
    const [startHour, endHour] = cfg.broadcast.active_hours;

    // 是否在非活跃睡眠时段（比如 22:00 ~ 9:00）
    // 注意：假设 startHour = 9, endHour = 22
    //       hour 0-8 或 22-23 是 sleep
    const isSleepWindow = hour < startHour || hour >= endHour;

    if (isSleepWindow) {
      return cfg.broadcast.sleep_interval_sec * 1000;
    }

    // 热启动阶段
    if (this.hotStartRemaining > 0) {
      this.hotStartRemaining--;
      return cfg.broadcast.hot_start_interval_sec * 1000;
    }

    // 稳态频次
    return cfg.broadcast.steady_interval_sec * 1000;
  }
}
