// ─────────────────────────────────────────────
// match-index.ts — Inverted Index for fast P2P matching
//
// 为了解决上万缓存节点的本地匹配性能瓶颈，
// 引入倒排索引 (Inverted Index) + Bloom Filter 概念。
// 我们在内存构建 skill -> node_id 的映射，
// 将 O(N) 遍历转换为 O(K) 查找 (K 为共有技能的节点数)。
// ─────────────────────────────────────────────

import type { BroadcastProfile } from "./types.js";

export class PeerIndex {
  // 倒排索引：技能名称 (小写) -> 拥有该技能的节点 ID 集合
  private skillInvertedMap = new Map<string, Set<string>>();
  // 节点库：node_id -> 节点完整 Profile
  private peerMap = new Map<string, BroadcastProfile>();

  /** 
   * 从全量缓存的 Peers 重建倒排索引
   */
  rebuild(peers: BroadcastProfile[]): void {
    this.skillInvertedMap.clear();
    this.peerMap.clear();

    for (const peer of peers) {
      if (!peer.node_id || !peer.skills) continue;
      this.peerMap.set(peer.node_id, peer);

      for (const skill of peer.skills) {
        const lowerSkill = skill.toLowerCase();
        let nodeSet = this.skillInvertedMap.get(lowerSkill);
        if (!nodeSet) {
          nodeSet = new Set<string>();
          this.skillInvertedMap.set(lowerSkill, nodeSet);
        }
        nodeSet.add(peer.node_id);
      }
    }
  }

  /**
   * O(1) 粗筛候选集
   * 
   * 只要对方和我们有 >= 1 个共同技能，就划入候选集进行后续深度打分。
   * 此举能淘汰掉 99% 的绝对不匹配节点（Java vs Python 等）。
   */
  getCandidates(ourSkills: Set<string>): BroadcastProfile[] {
    const candidateIds = new Set<string>();

    for (const skill of ourSkills) {
      const lowerSkill = skill.toLowerCase();
      const nodes = this.skillInvertedMap.get(lowerSkill);
      if (nodes) {
        for (const nodeId of nodes) {
          candidateIds.add(nodeId);
        }
      }
    }

    // 转换回 Profile 数组
    const candidates: BroadcastProfile[] = [];
    for (const id of candidateIds) {
      const peer = this.peerMap.get(id);
      if (peer) candidates.push(peer);
    }

    return candidates;
  }

  get stats() {
    return {
      totalPeers:  this.peerMap.size,
      totalSkills: this.skillInvertedMap.size,
    };
  }
}
