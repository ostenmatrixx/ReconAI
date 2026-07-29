import { ArrowRight, Check, FileCheck2, LockKeyhole, ScanSearch, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { SignInButton } from "../components/sign-in-button";
import { readServerSessionToken } from "../server-session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await readServerSessionToken();

  return (
    <main className="landing">
      <header className="landing__header">
        <Link className="wordmark wordmark--dark" href="/">
          <span className="wordmark__mark" aria-hidden="true">
            R
          </span>
          <span>
            ReconAI
            <small>Working name</small>
          </span>
        </Link>
        <span className="pre-release-label">Pre-release · Not production-ready</span>
      </header>

      <section className="landing__hero">
        <div className="landing__copy">
          <p className="eyebrow">Evidence before confidence</p>
          <h1>Reconciliation your finance team can actually defend.</h1>
          <p className="landing__lede">
            Bring read-only commerce, payment, and accounting records into one deterministic review
            workflow. Every mismatch keeps its source evidence. Every decision keeps its history.
          </p>
          <div className="landing__actions">
            {session ? (
              <>
                <Link className="button button--primary" href="/dashboard">
                  Open control desk
                  <ArrowRight aria-hidden="true" size={16} />
                </Link>
                <Link className="button button--quiet" href="/support">
                  <ShieldCheck aria-hidden="true" size={16} />
                  Restricted support
                </Link>
              </>
            ) : (
              <SignInButton />
            )}
            {session ? null : (
              <a className="button button--quiet" href="#safety">
                Review safety boundary
              </a>
            )}
          </div>
          <ul className="assurance-list">
            <li>
              <Check aria-hidden="true" size={14} />
              Integer money and explicit currency
            </li>
            <li>
              <Check aria-hidden="true" size={14} />
              Tenant-scoped records and jobs
            </li>
            <li>
              <Check aria-hidden="true" size={14} />
              Human approval; no source write-back
            </li>
          </ul>
        </div>

        <div aria-label="Reconciliation evidence flow" className="evidence-ledger">
          <div className="evidence-ledger__head">
            <span>Review packet</span>
            <code>RULE SET 1.0.0</code>
          </div>
          <div className="evidence-ledger__row">
            <span className="source-icon source-icon--shopify">S</span>
            <span>
              <strong>Shopify order</strong>
              <small>#R10482 · Paid</small>
            </span>
            <code>USD 842.00</code>
          </div>
          <div className="evidence-ledger__rule">
            <span>Exact order reference</span>
            <strong>
              <Check aria-hidden="true" size={14} /> Pass
            </strong>
          </div>
          <div className="evidence-ledger__row">
            <span className="source-icon source-icon--stripe">P</span>
            <span>
              <strong>Stripe payment</strong>
              <small>pi_•••891 · Succeeded</small>
            </span>
            <code>USD 840.00</code>
          </div>
          <div className="evidence-ledger__exception">
            <span>!</span>
            <div>
              <strong>Amount mismatch · USD 2.00</strong>
              <small>Deterministic exception · Human review required</small>
            </div>
          </div>
          <p className="sample-disclosure">
            Synthetic interface example. It is not customer or production data.
          </p>
        </div>
      </section>

      <section className="principle-grid" id="safety">
        <article>
          <ScanSearch aria-hidden="true" size={20} />
          <span>01</span>
          <h2>Deterministic first</h2>
          <p>Versioned rules remain reproducible with AI disabled. Conflicts stay visible.</p>
        </article>
        <article>
          <FileCheck2 aria-hidden="true" size={20} />
          <span>02</span>
          <h2>Evidence attached</h2>
          <p>Source, normalized value, rule, tolerance, version, and decision travel together.</p>
        </article>
        <article>
          <LockKeyhole aria-hidden="true" size={20} />
          <span>03</span>
          <h2>Read-only by design</h2>
          <p>V1 cannot issue a refund, change an order, or create an accounting entry.</p>
        </article>
      </section>
    </main>
  );
}
