import "dotenv/config";
import mongoose from "mongoose";
import { Order, Merchant } from "@ecom/db";
import { connectDb } from "../lib/db.js";
import {
  sendOrderConfirmationSms,
  sendSms,
  activeSmsProviderName,
  normalizeBdPhone,
} from "../lib/sms/index.js";
import { applyConfirmationOutcome } from "../lib/confirmation-outcome.js";
import { normalizePhone } from "../lib/phone.js";

/**
 * Dev utility — drive a single real BD confirmation SMS through the
 * configured provider end-to-end. Use this to validate the full lifecycle
 * (outbound dispatch → inbound YES/NO → outcome engine → order flip)
 * against a live BD number before flipping IVR escalation on.
 *
 * Modes (positional arg 1):
 *   send <phone> [code] [orderNumber]
 *     Dispatch a fresh confirmation SMS template to <phone>. Mints (or
 *     accepts) a 6-digit code and prints what to reply. NO database
 *     touch — for raw provider validation.
 *
 *   send-for-order <orderId>
 *     Look up a pending_confirmation order, send the templated SMS to
 *     its stored phone, return the code. Validates the templating + the
 *     same call-path the automation worker takes.
 *
 *   simulate <code> <phone> <confirm|reject>
 *     Bypass the inbound webhook and run `applyConfirmationOutcome`
 *     directly. Useful when you want to verify the engine flips state
 *     without dragging a real reply through the gateway.
 *
 *   raw <phone> <message>
 *     Plumbing-test: send an arbitrary body via `sendSms`. Validates the
 *     transport + provider response parsing without any templating.
 *
 * Examples:
 *   npm --workspace apps/api run sms:test -- send +8801XXXXXXXXX
 *   npm --workspace apps/api run sms:test -- send-for-order 671c...
 *   npm --workspace apps/api run sms:test -- simulate 482917 +8801XX confirm
 *   npm --workspace apps/api run sms:test -- raw +8801XX "ConfirmX test"
 */

function usage(): never {
  console.error(
    "usage:\n" +
      "  send <phone> [code] [orderNumber]\n" +
      "  send-for-order <orderId>\n" +
      "  simulate <code> <phone> <confirm|reject>\n" +
      "  raw <phone> <message>",
  );
  process.exit(2);
}

function mint6Digit(): string {
  return String(Math.floor(100_000 + Math.random() * 900_000));
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (!mode) usage();

  console.log(`[sms:test] provider=${activeSmsProviderName()} mode=${mode}`);
  await connectDb();

  try {
    switch (mode) {
      case "send": {
        const [phoneArg, codeArg, orderNumberArg] = rest;
        if (!phoneArg) usage();
        const code = codeArg ?? mint6Digit();
        const orderNumber = orderNumberArg ?? `TEST-${Date.now().toString().slice(-6)}`;
        const phone = normalizePhone(phoneArg) ?? phoneArg;
        const result = await sendOrderConfirmationSms(phone, {
          orderNumber,
          confirmationCode: code,
          codAmount: 1200,
        });
        printResult(result);
        if (result.ok) {
          console.log(
            `\n[sms:test] reply expected: "YES ${code}" to confirm, "NO ${code}" to reject`,
          );
        }
        break;
      }

      case "send-for-order": {
        const [orderId] = rest;
        if (!orderId) usage();
        const order = await Order.findById(orderId)
          .select(
            "merchantId orderNumber customer.phone order.cod automation.state automation.confirmationCode",
          )
          .lean<{
            _id: unknown;
            merchantId: { toString(): string };
            orderNumber: string;
            customer: { phone: string };
            order: { cod: number };
            automation?: { state?: string; confirmationCode?: string };
          }>();
        if (!order) {
          console.error(`[sms:test] order ${orderId} not found`);
          process.exit(3);
        }
        if (order.automation?.state !== "pending_confirmation") {
          console.error(
            `[sms:test] order is in state '${order.automation?.state}', not 'pending_confirmation' — refusing`,
          );
          process.exit(3);
        }
        const code = order.automation.confirmationCode ?? mint6Digit();
        const merchant = await Merchant.findById(order.merchantId)
          .select("businessName")
          .lean<{ businessName?: string } | null>();
        const result = await sendOrderConfirmationSms(order.customer.phone, {
          brand: merchant?.businessName,
          orderNumber: order.orderNumber,
          codAmount: order.order.cod,
          confirmationCode: code,
        });
        printResult(result);
        if (result.ok) {
          console.log(
            `\n[sms:test] orderId=${orderId} code=${code}\n` +
              `[sms:test] reply expected: "YES ${code}" / "NO ${code}"`,
          );
        }
        break;
      }

      case "simulate": {
        const [code, phoneArg, decision] = rest;
        if (!code || !phoneArg || !decision) usage();
        if (decision !== "confirm" && decision !== "reject") usage();
        const phone = normalizePhone(phoneArg) ?? phoneArg;
        const outcome = await applyConfirmationOutcome({
          code,
          phone,
          decision,
          channel: "sms",
          meta: { source: "dev-script", fromTail: phone.slice(-4) },
        });
        console.log(`[sms:test] outcome:`, JSON.stringify(outcome, null, 2));
        break;
      }

      case "raw": {
        const [phoneArg, ...msgParts] = rest;
        if (!phoneArg || msgParts.length === 0) usage();
        const phone = normalizeBdPhone(phoneArg) ?? phoneArg;
        const result = await sendSms(phone, msgParts.join(" "), {
          tag: "dev_raw",
          csmsId: `dev-raw-${Date.now()}`,
        });
        printResult(result);
        break;
      }

      default:
        usage();
    }
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

function printResult(r: {
  ok: boolean;
  provider?: string;
  providerStatus?: string;
  providerMessageId?: string;
  error?: string;
}) {
  if (r.ok) {
    console.log(
      `[sms:test] ok provider=${r.provider} status=${r.providerStatus} id=${r.providerMessageId}`,
    );
  } else {
    console.error(
      `[sms:test] FAIL provider=${r.provider} status=${r.providerStatus} error=${r.error}`,
    );
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error("[sms:test] unhandled:", err);
  process.exit(1);
});
