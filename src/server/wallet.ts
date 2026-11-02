// The game's own Lightning wallet, connected with Nostr Wallet Connect (NIP-47): the host pastes
// a connection string from their wallet app (coinos, Alby Hub, LNbits…), funds it, and when the
// show ends the game pays the winner's Lightning address itself. The connection string is a
// secret: it lives in the data folder only, never in the public state.
//
// Paying a Lightning address (LNURL-pay, LUD-16): ask the address's server for its payment
// details, ask it for an invoice for the amount, check the invoice is for that amount, pay it.

import { NWCClient } from "@getalby/sdk/nwc";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UA = { "User-Agent": "treasure-tiles/0.1 (+https://bitcoinship.show)" };

export class Wallet {
  private client: NWCClient | null = null;
  private file: string;
  alias = "";

  constructor(dataDir: string) {
    this.file = join(dataDir, "wallet-nwc.txt");
    if (existsSync(this.file)) this.connect(readFileSync(this.file, "utf8").trim(), false).catch(() => {});
  }

  get connected() {
    return !!this.client;
  }

  /** Save and test a connection string (`nostr+walletconnect://…`). */
  async connect(url: string, save = true) {
    if (!/^nostr\+walletconnect:\/\//.test(url)) throw new Error("That isn't a Nostr Wallet Connect string (it starts with nostr+walletconnect://)");
    const client = new NWCClient({ nostrWalletConnectUrl: url });
    const info = await withTimeout(client.getInfo(), 12_000, "The wallet didn't answer");
    if (!info.methods.includes("pay_invoice" as never)) throw new Error("This connection can't pay invoices: give it the pay_invoice permission");
    this.client?.close();
    this.client = client;
    this.alias = [info.alias, info.network].filter(Boolean).join(" · ");
    if (save) writeFileSync(this.file, url, { mode: 0o600 });
  }

  disconnect() {
    this.client?.close();
    this.client = null;
    this.alias = "";
    rmSync(this.file, { force: true });
  }

  /** Balance in sats, or null if the wallet won't say. */
  async balance(): Promise<number | null> {
    if (!this.client) return null;
    try {
      const b = await withTimeout(this.client.getBalance(), 10_000, "timeout");
      return Math.floor(b.balance / 1000);
    } catch {
      return null;
    }
  }

  /** Pay an invoice the winner's wallet made (the scan-to-receive QR). */
  async payInvoice(invoice: string): Promise<string> {
    if (!this.client) throw new Error("No game wallet is connected");
    const r = await withTimeout(this.client.payInvoice({ invoice }), 60_000, "The wallet didn't confirm the payment in time (check it before retrying)");
    return r.preimage;
  }

  /** Pay a Lightning address. Resolves with the payment preimage, or throws in plain words. */
  async payAddress(address: string, sats: number, comment: string): Promise<string> {
    if (!this.client) throw new Error("No game wallet is connected");
    const invoice = await invoiceFor(address, sats, comment);
    const r = await withTimeout(this.client.payInvoice({ invoice }), 60_000, "The wallet didn't confirm the payment in time (check it before retrying)");
    return r.preimage;
  }
}

/** Ask a Lightning address for an invoice of exactly this many sats. */
export async function invoiceFor(address: string, sats: number, comment = ""): Promise<string> {
  const m = /^([a-z0-9._+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(address.trim());
  if (!m) throw new Error("That isn't a Lightning address");
  const [, user, domain] = m;
  const info = await getJson(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`);
  if (info.tag !== "payRequest" || typeof info.callback !== "string") throw new Error(`${address} isn't set up to receive payments`);
  const msat = sats * 1000;
  if (msat < info.minSendable || msat > info.maxSendable) throw new Error(`${address} won't take ${sats} sats (it accepts ${Math.ceil(info.minSendable / 1000)}–${Math.floor(info.maxSendable / 1000)})`);
  const url = new URL(info.callback);
  url.searchParams.set("amount", String(msat));
  if (comment && info.commentAllowed) url.searchParams.set("comment", comment.slice(0, info.commentAllowed));
  const r = await getJson(url.toString());
  if (r.status === "ERROR" || typeof r.pr !== "string") throw new Error(r.reason || `${address} didn't give an invoice`);
  if (!invoiceAmountIs(r.pr, msat)) throw new Error(`${address} gave an invoice for the wrong amount`);
  return r.pr;
}

/** Checks a BOLT11 invoice's amount (the digits and unit after "lnbc"). */
export function invoiceAmountIs(pr: string, msat: number) {
  const m = /^ln(?:bc|tb|bcrt)(\d+)([munp]?)1/i.exec(pr);
  if (!m) return false;
  const n = BigInt(m[1]);
  // amount in bitcoin × multiplier → millisats (1 BTC = 1e11 msat)
  const msats = m[2] === "m" ? n * 100_000_000n : m[2] === "u" ? n * 100_000n : m[2] === "n" ? n * 100n : m[2] === "p" ? n / 10n : n * 100_000_000_000n;
  return msats === BigInt(msat);
}

async function getJson(url: string) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000), redirect: "follow" });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Couldn't reach ${new URL(url).host} for the payment`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}
