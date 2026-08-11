import type { ActivityEntry } from "./store.js";

interface DiscordPayload {
  content?: string;
  embeds?: {
    title?: string;
    description?: string;
    color?: number;
    fields?: { name: string; value: string; inline?: boolean }[];
    timestamp?: string;
  }[];
}

class DiscordRelay {
  private webhookUrl: string | null = null;
  private lastPost = 0;

  setWebhook(url: string): void {
    this.webhookUrl = url;
  }

  private canPost(): boolean {
    // Rate-limit ourselves to one Discord post per 30s to avoid spam.
    if (Date.now() - this.lastPost < 30_000) return false;
    this.lastPost = Date.now();
    return true;
  }

  async postStatus(credits: number, ships: number, netProfit: number): Promise<void> {
    if (!this.webhookUrl || !this.canPost()) return;
    const payload: DiscordPayload = {
      embeds: [{
        title: "Startraders Fleet Status",
        color: 0x4fd1c5,
        fields: [
          { name: "Credits", value: credits.toLocaleString("en-US"), inline: true },
          { name: "Ships", value: String(ships), inline: true },
          { name: "Net Profit", value: netProfit.toLocaleString("en-US"), inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    };
    await this.send(payload);
  }

  async postActivity(entry: ActivityEntry): Promise<void> {
    if (!this.webhookUrl) return;
    // Only post notable events immediately.
    if (entry.kind !== "sell" && entry.kind !== "buy" && !entry.detail.toLowerCase().includes("purchased ship")) return;
    const payload: DiscordPayload = {
      embeds: [{
        description: `**${entry.shipSymbol}** ${entry.kind}: ${entry.detail}${entry.credits != null ? ` (${entry.credits >= 0 ? "+" : ""}${entry.credits.toLocaleString("en-US")}c)` : ""}`,
        color: entry.kind === "sell" ? 0x7dd87d : entry.kind === "buy" ? 0xff6b6b : 0xffb454,
        timestamp: entry.timestamp,
      }],
    };
    await this.send(payload);
  }

  private async send(payload: DiscordPayload): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("[discord] webhook post failed", err);
    }
  }
}

let instance: DiscordRelay | undefined;

export function getDiscord(): DiscordRelay {
  if (!instance) instance = new DiscordRelay();
  return instance;
}
