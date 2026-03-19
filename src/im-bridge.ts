// ─────────────────────────────────────────────
// im-bridge.ts — OpenClaw IM Channel 桥接
//
// 在 TCP 直连文档交换完成后，自动创建持久化 IM 通道绑定。
// TCP 断开后，双方可通过 OpenClaw IM Channel 继续沟通。
//
// Protocol (over TCP line-JSON):
//   { type: "im_bind", im_channel_id: "...", peer_title: "..." }
// ─────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────

export interface IMChannelBinding {
  peer_node_id:    string;       // 对方的 P2P 节点 ID
  peer_title:      string;       // 对方的职位/姓名（方便识别）
  im_channel_id:   string;       // IM 频道 ID（双方共享）
  role:            "initiator" | "responder";  // 谁发起的绑定
  created_at:      number;       // Unix ms
  last_active:     number;       // 最近活跃时间 Unix ms
  doc_exchanged:   boolean;      // 是否已完成文档交换
}

/**
 * IM Provider 接口 — 可替换为任何 IM 后端
 *
 * 默认实现 LocalIMProvider 只做本地记录。
 * 生产环境替换为 OpenClaw IM SDK。
 */
export interface IMProvider {
  /** 创建一个新的 IM 频道，返回频道 ID */
  createChannel(peerNodeId: string, myNodeId: string): Promise<string>;

  /** 向 IM 频道发送一条系统消息（如"文档交换完成"通知） */
  sendSystemMessage(channelId: string, message: string): Promise<void>;
}

// ── Local IM Provider（默认实现）─────────────────────────────────────────

export class LocalIMProvider implements IMProvider {
  async createChannel(peerNodeId: string, myNodeId: string): Promise<string> {
    // 用双方 node_id 前缀 + 随机数生成确定性 channel ID
    const prefix = [myNodeId.slice(0, 8), peerNodeId.slice(0, 8)].sort().join("-");
    const rand   = randomBytes(4).toString("hex");
    return `im-${prefix}-${rand}`;
  }

  async sendSystemMessage(channelId: string, message: string): Promise<void> {
    console.log(`[im-bridge] [${channelId}] ${message}`);
  }
}

// ── IM Bridge ─────────────────────────────────────────────────────────────

export class IMBridge {
  private dataDir:   string;
  private myNodeId:  string;
  private myTitle:   string;
  private provider:  IMProvider;
  private bindings:  Map<string, IMChannelBinding>;
  private filePath:  string;

  constructor(opts: {
    dataDir:   string;
    myNodeId:  string;
    myTitle:   string;
    provider?: IMProvider;
  }) {
    this.dataDir  = opts.dataDir;
    this.myNodeId = opts.myNodeId;
    this.myTitle  = opts.myTitle;
    this.provider = opts.provider ?? new LocalIMProvider();
    this.filePath = join(this.dataDir, "im_bindings.json");
    this.bindings = new Map();
    this.loadFromDisk();
  }

  // ── TCP 连接完成后调用 ──────────────────────────────────────────────────

  /**
   * 文档交换成功后调用。
   * 
   * @param peerNodeId  对方节点 ID
   * @param peerTitle   对方 title（从 profile 或文档中获取）
   * @returns  要通过 TCP 发送给对方的 im_bind 消息（JSON 行），
   *           如果已有绑定则返回 null
   */
  async onDocExchanged(
    peerNodeId: string,
    peerTitle:  string,
  ): Promise<{ im_channel_id: string; message: string } | null> {

    // 已有绑定 → 更新 last_active，不重复创建
    const existing = this.bindings.get(peerNodeId);
    if (existing) {
      existing.last_active    = Date.now();
      existing.doc_exchanged  = true;
      this.saveToDisk();
      console.log(`[im-bridge] 复用已有 IM 通道: ${existing.im_channel_id}`);
      return null;  // 不需要再发 im_bind
    }

    // 创建新 IM 频道
    const channelId = await this.provider.createChannel(peerNodeId, this.myNodeId);

    const binding: IMChannelBinding = {
      peer_node_id:   peerNodeId,
      peer_title:     peerTitle,
      im_channel_id:  channelId,
      role:           "initiator",
      created_at:     Date.now(),
      last_active:    Date.now(),
      doc_exchanged:  true,
    };

    this.bindings.set(peerNodeId, binding);
    this.saveToDisk();

    await this.provider.sendSystemMessage(
      channelId,
      `✅ 与 ${peerTitle} (${peerNodeId.slice(0, 16)}…) 建立 IM 通道`
    );

    console.log(`[im-bridge] 新建 IM 通道: ${channelId} ↔ ${peerTitle}`);

    // 返回要通过 TCP 发给对方的 im_bind 消息
    const bindMsg = JSON.stringify({
      type:           "im_bind",
      im_channel_id:  channelId,
      peer_title:     this.myTitle,
    });

    return { im_channel_id: channelId, message: bindMsg };
  }

  // ── 收到对方的 im_bind 消息 ─────────────────────────────────────────────

  /**
   * 处理对方通过 TCP 发来的 im_bind 消息。
   * 如果本地没有该 peer 的绑定，则创建一个 responder 绑定。
   */
  onIMBind(peerNodeId: string, channelId: string, peerTitle: string): void {
    const existing = this.bindings.get(peerNodeId);

    if (existing) {
      // 已有绑定（我们是 initiator），只更新活跃时间
      existing.last_active = Date.now();
      this.saveToDisk();
      return;
    }

    // 我们是 responder — 保存对方创建的频道
    const binding: IMChannelBinding = {
      peer_node_id:   peerNodeId,
      peer_title:     peerTitle,
      im_channel_id:  channelId,
      role:           "responder",
      created_at:     Date.now(),
      last_active:    Date.now(),
      doc_exchanged:  true,
    };

    this.bindings.set(peerNodeId, binding);
    this.saveToDisk();

    console.log(`[im-bridge] 接收 IM 通道绑定: ${channelId} ↔ ${peerTitle}`);
  }

  // ── 查询 ────────────────────────────────────────────────────────────────

  /** 获取指定 peer 的 IM 绑定（如存在） */
  getBinding(peerNodeId: string): IMChannelBinding | undefined {
    return this.bindings.get(peerNodeId);
  }

  /** 列出所有 IM 绑定 */
  listBindings(): IMChannelBinding[] {
    return [...this.bindings.values()]
      .sort((a, b) => b.last_active - a.last_active);
  }

  /** 按 IM channel ID 查找绑定 */
  findByChannel(channelId: string): IMChannelBinding | undefined {
    return [...this.bindings.values()].find(
      (b) => b.im_channel_id === channelId
    );
  }

  /** 删除一个绑定 */
  remove(peerNodeId: string): boolean {
    const ok = this.bindings.delete(peerNodeId);
    if (ok) this.saveToDisk();
    return ok;
  }

  // ── 格式化输出 ──────────────────────────────────────────────────────────

  formatBindings(): string {
    const list = this.listBindings();
    if (list.length === 0) return "  暂无 IM 通道";

    return list.map((b, i) => {
      const ago   = this.timeAgo(b.last_active);
      const role  = b.role === "initiator" ? "发起" : "接收";
      return [
        `  ${i + 1}. ${b.peer_title}`,
        `     Channel: ${b.im_channel_id}`,
        `     Node:    ${b.peer_node_id.slice(0, 28)}…`,
        `     角色: ${role}  文档: ${b.doc_exchanged ? "✓" : "✗"}  活跃: ${ago}`,
      ].join("\n");
    }).join("\n\n");
  }

  // ── 持久化 ──────────────────────────────────────────────────────────────

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data: IMChannelBinding[] = JSON.parse(readFileSync(this.filePath, "utf8"));
      for (const b of data) this.bindings.set(b.peer_node_id, b);
      console.log(`[im-bridge] 加载 ${this.bindings.size} 个 IM 通道绑定`);
    } catch {
      console.warn("[im-bridge] im_bindings.json 损坏，重置");
    }
  }

  private saveToDisk(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const data = [...this.bindings.values()];
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  private timeAgo(ms: number): string {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60)   return `${sec}秒前`;
    if (sec < 3600)  return `${Math.floor(sec / 60)}分钟前`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}小时前`;
    return `${Math.floor(sec / 86400)}天前`;
  }
}
