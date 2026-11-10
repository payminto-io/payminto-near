/**
 * A seller process for `voucher-store.test.ts`: it opens the voucher file it is given and stores vouchers for payees
 * of its own, as a second container on the same volume would. Not a test file.
 *
 *   node voucher-writer.ts <store path> <writer name> <count> <start file>
 *
 * It waits for the start file to appear, so several writers begin at the same moment.
 */
import { existsSync } from "node:fs";
import { FileVoucherStore } from "../src/voucher-store.ts";
import { storedVoucher } from "./voucher-fixture.ts";

const [path, name, count, start] = process.argv.slice(2);
if (!path || !name || !count || !start) throw new Error("usage: voucher-writer.ts <store path> <writer name> <count> <start file>");

const pause = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(start)) Atomics.wait(pause, 0, 0, 1);

const store = new FileVoucherStore(path);
for (let i = 0; i < Number(count); i++) store.put(storedVoucher(`${name}-${i}.testnet`, 1000n * BigInt(i + 1)));
store.close();
