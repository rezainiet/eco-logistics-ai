"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, HelpCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const FAQS = [
  {
    q: "How do I connect my courier?",
    a: "Open Settings → Couriers and click Add courier. You will need the API key from your courier portal (Steadfast / Pathao / RedX). If you do not have one, call your courier representative — they can email it to you.",
  },
  {
    q: "Why are some of my orders in the review queue?",
    a: "Orders go to review when our fraud signals flag them as risky (repeat-failed phone, unusually high COD, etc.). Open the Review tab to confirm or reject in bulk after a quick call to the customer.",
  },
  {
    q: "My SMS confirmations are not sending — what should I do?",
    a: "First check your SSL Wireless balance — most failures are insufficient-credit. The dashboard banner will tell you when SMS is queued. Top up and retry; failed orders auto-escalate to the review queue after 24 hours.",
  },
  {
    q: "How do I import existing orders?",
    a: "On the Orders page click Upload CSV. We will count the rows and warn you about how many SMSes will be sent before you confirm. If you are on Shopify or WooCommerce, click Import recent on the integration card instead.",
  },
  {
    q: "Is my data safe?",
    a: "Yes. All connections use HTTPS, courier credentials are encrypted at rest, and customer data is scoped to your account. Cross-merchant fraud signals use one-way hashes — we never see another merchant's customers in plain text.",
  },
];

const QUICK_STEPS = [
  "Connect at least one courier under Settings → Couriers.",
  "Add your first order — paste it manually, upload a CSV, or import from Shopify.",
  "Turn on automation under Settings → Automation. Choose manual, semi-auto, or full auto.",
  "Send a test SMS to make sure your gateway is configured. The 4-step Getting Started page walks you through it.",
];

export function HelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open help"
        title="Help"
        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-stroke/12 bg-surface px-2.5 text-xs font-medium text-fg-subtle transition-colors hover:border-stroke/24 hover:text-fg sm:px-3"
      >
        <HelpCircle className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">Help</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Quick help</DialogTitle>
          </DialogHeader>
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                Getting started
              </h3>
              <ol className="ml-4 list-decimal space-y-1.5 text-xs text-fg-muted">
                {QUICK_STEPS.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              <Link
                href="/dashboard/getting-started"
                onClick={() => setOpen(false)}
                className="mt-2 inline-flex items-center gap-1 text-2xs font-medium text-brand hover:underline"
              >
                Open the full Getting started page
                <ExternalLink className="h-3 w-3" aria-hidden />
              </Link>
            </section>
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                Frequently asked
              </h3>
              <dl className="space-y-3">
                {FAQS.map((faq, i) => (
                  <div key={i}>
                    <dt className="text-xs font-semibold text-fg">{faq.q}</dt>
                    <dd className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                      {faq.a}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
            <p className="border-t border-stroke/8 pt-3 text-2xs text-fg-faint">
              Still stuck? Tap the Support button in the topbar to chat with us.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
