// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RefundPolicy — in-app modal that renders the policy text.
//
//  Why in-app instead of just linking out to minicaai.com/refund-policy:
//    1. Works offline / on a flaky connection
//    2. No risk of a stale or broken external link bricking the legal
//       disclosure right when a user is mid-billing-question
//    3. Bundled with the binary, so the version of the policy a user
//       reads matches the version of the app they're on
//    4. Consistent dark aesthetic — no jarring jump out to the marketing
//       site mid-billing flow
//
//  The corresponding markdown source of truth lives at REFUND_POLICY.md
//  at the repo root. Keep the two in sync — when one changes, the other
//  must change in the same commit.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { useAnimatedModal } from './hooks/useAnimatedModal';

interface RefundPolicyProps {
  isOpen: boolean;
  onClose: () => void;
}

const EFFECTIVE_DATE = 'July 7, 2026';
const LAST_UPDATED = 'July 7, 2026';

export function RefundPolicy({ isOpen, onClose }: RefundPolicyProps) {
  // Same smooth-modal pattern as ManageSubscription. Backdrop fades,
  // content slides into place. 220ms duration matches the rest of the
  // app's modal vocabulary so transitions between Manage → Refund Policy
  // feel like a single continuous gesture rather than two separate pops.
  const { isMounted, isVisible } = useAnimatedModal(isOpen, 220);

  // Esc closes — same a11y pattern as ManageSubscription.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isMounted) return null;

  return (
    <div
      // z-index above ManageSubscription (which uses z-[99999]) so this
      // overlays the billing surface when opened from its footer.
      // Backdrop fades in/out; content body has its own subtle lift.
      className={`fixed inset-0 z-[999999] overflow-y-auto custom-scrollbar transition-opacity duration-200 ease-out ${
        isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      style={{ backgroundColor: 'rgba(0,0,0,0.85)', WebkitAppRegion: 'no-drag' } as any}
      role="dialog"
      aria-modal="true"
      aria-label="Refund policy"
    >
      {/* Sticky top bar — title + close. Matches ManageSubscription's
          chrome so a user moving between the two surfaces doesn't notice
          a visual jump. */}
      <div className="sticky top-0 z-10 bg-[#0a0a0d]/95 border-b border-white/[0.06] px-6 py-3 flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">Refund Policy</h2>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg hover:bg-white/[0.08] flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      <article
        className={`max-w-3xl mx-auto px-6 py-8 space-y-6 text-[14px] leading-relaxed text-white/80 transition-all duration-200 ease-out ${
          isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
        }`}
      >
        {/* Effective date strip */}
        <div className="text-xs text-white/50 flex flex-wrap gap-x-4 gap-y-1">
          <span><span className="text-white/40">Effective:</span> {EFFECTIVE_DATE}</span>
          <span className="text-white/30">·</span>
          <span><span className="text-white/40">Last updated:</span> {LAST_UPDATED}</span>
        </div>

        <p>
          This policy explains when and how minicaai (&ldquo;the Service&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) issues refunds for purchases of our AI interview copilot. By purchasing a plan you agree to the terms below.
        </p>
        <p className="text-white/70">
          We aim to be fair: if you bought a plan you genuinely couldn&rsquo;t use, we&rsquo;ll refund it. If you&rsquo;ve consumed the value, we won&rsquo;t.
        </p>

        {/* Section 1 — Eligibility table */}
        <Section title="1. Eligibility window by plan">
          <div className="overflow-x-auto rounded-xl border border-white/10 my-3">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-white/[0.03] text-left">
                  <th className="px-4 py-2.5 text-white/70 font-medium">Plan</th>
                  <th className="px-4 py-2.5 text-white/70 font-medium">Refund window</th>
                  <th className="px-4 py-2.5 text-white/70 font-medium">Usage condition</th>
                </tr>
              </thead>
              <tbody className="text-white/75">
                <tr className="border-t border-white/5">
                  <td className="px-4 py-2.5 align-top"><strong className="text-white">Basic</strong><br /><span className="text-white/50 text-[11px]">$30 / ₹2,499 · one-time · one 30-minute interview</span></td>
                  <td className="px-4 py-2.5 align-top">14 days from purchase</td>
                  <td className="px-4 py-2.5 align-top">Less than 2 hours of total session time</td>
                </tr>
                <tr className="border-t border-white/5 bg-white/[0.015]">
                  <td className="px-4 py-2.5 align-top"><strong className="text-white">Pro</strong><br /><span className="text-white/50 text-[11px]">$50 / ₹4,199 · one-time · one 1-hour interview</span></td>
                  <td className="px-4 py-2.5 align-top">14 days from purchase</td>
                  <td className="px-4 py-2.5 align-top">Less than 2 hours of total session time</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="px-4 py-2.5 align-top"><strong className="text-white">Max</strong><br /><span className="text-white/50 text-[11px]">$89 / ₹7,399 · one-time · three 1-hour interviews</span></td>
                  <td className="px-4 py-2.5 align-top">14 days from purchase</td>
                  <td className="px-4 py-2.5 align-top">Less than 2 hours of total session time</td>
                </tr>
                <tr className="border-t border-white/5 bg-white/[0.015]">
                  <td className="px-4 py-2.5 align-top"><strong className="text-white">Ultra</strong><br /><span className="text-white/50 text-[11px]">$159/mo · ₹12,999/mo</span></td>
                  <td className="px-4 py-2.5 align-top">14 days from the <strong className="text-white">first</strong> charge</td>
                  <td className="px-4 py-2.5 align-top">Less than 2 hours of total session time</td>
                </tr>
                <tr className="border-t border-white/5">
                  <td className="px-4 py-2.5 align-top"><strong className="text-white">Interview extensions</strong><br /><span className="text-white/50 text-[11px]">+30 min / +1 h / +3 h top-ups ($25–$80 / ₹2,099–₹6,799)</span></td>
                  <td className="px-4 py-2.5 align-top">Not refundable once delivered</td>
                  <td className="px-4 py-2.5 align-top">—</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>These windows apply to your <strong className="text-white">first</strong> purchase of the Service. For repeat purchases, write to us anyway — we read every request and make fair exceptions.</p>
          <p>A &ldquo;session&rdquo; is any active interview session, including ones ended early. Live transcription, Auto-Solve captures, the pop-out overlay, and chat usage during an active interview all count toward session time.</p>
          <p>Refund eligibility is determined by our session logs, which are immutable and timestamped.</p>
        </Section>

        <Section title={<>2. What is <strong className="text-white">not</strong> refundable</>}>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>Interview extension top-ups (+30 min / +1 h / +3 h — $25&ndash;$80 / ₹2,099&ndash;₹6,799) once they&rsquo;ve been added to your balance, even if unused</li>
            <li>Ultra billing cycles <strong className="text-white">after</strong> the first &mdash; cancel any time to stop the next renewal, but charges already made are not refunded</li>
            <li>Any plan after the eligibility window above has elapsed</li>
            <li>Any plan where the usage threshold has been exceeded</li>
            <li>Accounts terminated for violation of our Terms of Service (sharing credentials, automated abuse, etc.)</li>
            <li>Currency conversion fees, bank wire fees, or foreign-exchange differences charged by your bank &mdash; only the amount we collected is refunded</li>
          </ul>
        </Section>

        <Section title="3. How to request a refund">
          <ol className="list-decimal pl-5 space-y-1.5">
            <li>Email <strong className="text-white">support@minicaai.com</strong> from the email address on your account.</li>
            <li>
              Include:
              <ul className="list-disc pl-5 mt-1 space-y-1 text-white/70">
                <li>Your receipt or last 4 digits of the card / payment ID</li>
                <li>The plan you&rsquo;d like refunded</li>
                <li>A brief reason (we read every one &mdash; it&rsquo;s how we improve)</li>
              </ul>
            </li>
            <li>We respond within <strong className="text-white">2 business days</strong>. Most refunds are approved on first reply.</li>
          </ol>
          <p>We do <strong className="text-white">not</strong> require a phone call, video call, or any cancellation form. The email above is the entire process.</p>
        </Section>

        <Section title="4. Refund processing time">
          <p>Once approved, refunds are issued back to the original payment method:</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li><strong className="text-white">Stripe (USD, global cards):</strong> 5–10 business days</li>
            <li><strong className="text-white">Razorpay (INR, India):</strong> Card refunds 5–7 business days; UPI / wallet refunds 1–3 business days</li>
          </ul>
          <p>If your statement still doesn&rsquo;t show the refund after the expected window, reply to our approval email and we&rsquo;ll provide the provider&rsquo;s refund reference for you to take to your bank.</p>
        </Section>

        <Section title="5. Cancellation is not the same as a refund">
          <p>This section applies to the <strong className="text-white">Ultra</strong> subscription &mdash; one-time interview passes (Basic, Pro, Max) have nothing to cancel; they simply expire.</p>
          <p>Clicking <strong className="text-white">Cancel subscription</strong> in-app stops the next renewal charge. You keep access to your paid tier until the end of the current billing cycle &mdash; that&rsquo;s the value you already paid for. No refund is issued for the current cycle on cancellation.</p>
          <p>If you want to stop renewing <strong className="text-white">and</strong> be refunded for the current cycle, both must be requested &mdash; and the refund still depends on the eligibility window above.</p>
          <p>You can also reactivate a scheduled cancellation any time before the cycle ends, directly from the <strong className="text-white">Manage subscription</strong> screen.</p>
        </Section>

        <Section title="6. Service outages and downtime">
          <p>If a verified service outage on our side prevents you from using the Service for more than 48 consecutive hours during your billing period, we&rsquo;ll apply a pro-rated credit to your next renewal automatically. This applies to the <strong className="text-white">Ultra</strong> subscription. One-time pass holders (Basic, Pro, Max) in this situation are eligible for a refund or replacement interview credits.</p>
          <p>Outages on third-party services we depend on (Stripe, Razorpay, Deepgram, AI model providers, your internet, your camera/mic drivers) are not covered.</p>
        </Section>

        <Section title="7. Chargebacks and disputes">
          <p>Filing a chargeback or payment dispute with your bank or card network instead of contacting us first will result in immediate, permanent termination of your account and forfeiture of any unused credits &mdash; regardless of the dispute outcome.</p>
          <p>If you have any concern about a charge, <strong className="text-white">email us first</strong>. We&rsquo;d much rather refund a legitimate dispute in 2 business days than fight a chargeback for 90 days.</p>
        </Section>

        <Section title="8. Region-specific notes">
          <ul className="list-disc pl-5 space-y-2">
            <li><strong className="text-white">India (Razorpay payments):</strong> Refunds are issued in INR to the original payment instrument. GST collected on your purchase is refunded along with the principal. Subscription cancellations may be requested through us; Razorpay does not provide a self-serve customer portal.</li>
            <li><strong className="text-white">United States and other Stripe regions (USD):</strong> Refunds are issued in USD. You can also self-serve cancellations and view past invoices via the Stripe billing portal linked from your <strong className="text-white">Manage subscription</strong> screen.</li>
          </ul>
        </Section>

        <Section title="9. Changes to this policy">
          <p>We may update this policy from time to time. Material changes &mdash; anything that reduces refund eligibility &mdash; will be communicated by email to all active subscribers at least <strong className="text-white">30 days before</strong> the change takes effect. Non-material changes (clarifications, formatting, contact info updates) take effect immediately.</p>
          <p>The version of this policy in force at the time of your purchase governs that purchase, even if the policy changes later.</p>
        </Section>

        <Section title="10. Contact">
          <ul className="list-none pl-0 space-y-1">
            <li><span className="text-white/50">Email:</span> <a href="mailto:support@minicaai.com" className="text-blue-400 hover:text-blue-300 underline">support@minicaai.com</a></li>
            <li><span className="text-white/50">Response time:</span> within 2 business days</li>
            <li><span className="text-white/50">Operator:</span> the minicaai team</li>
          </ul>
        </Section>

        <hr className="border-white/10" />
        <p className="text-white/55 italic text-[13px]">
          If anything in this policy is unclear or you believe we should refund a charge that doesn&rsquo;t fit the rules above, write to us. We read everything and we&rsquo;d rather make a fair exception than lose your trust.
        </p>
      </article>
    </div>
  );
}

// Small helper to keep section spacing/typography consistent without
// repeating the same className soup ten times. Title accepts ReactNode
// so headings can include inline emphasis (e.g. "What is *not* refundable").
function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-base font-semibold text-white pt-2">{title}</h3>
      <div className="space-y-2 text-white/80">
        {children}
      </div>
    </section>
  );
}
