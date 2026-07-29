import {
  Activity,
  Archive,
  BookOpenCheck,
  Cable,
  FileClock,
  LayoutList,
  Settings,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { OrganizationSwitcher } from "./organization-switcher";
import { SignOutButton } from "./sign-out-button";

const navigation = [
  { label: "Exceptions", href: "/dashboard", icon: LayoutList },
  { label: "Reconciliation runs", href: "/dashboard/runs", icon: FileClock },
  { label: "Connectors", href: "/dashboard/connectors", icon: Cable },
  { label: "Audit history", href: "/dashboard/audit", icon: Archive },
] as const;

export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="app-frame">
      <aside aria-label="Application navigation" className="sidebar">
        <Link className="wordmark" href="/dashboard">
          <span className="wordmark__mark" aria-hidden="true">
            R
          </span>
          <span>
            ReconAI
            <small>Working name</small>
          </span>
        </Link>
        <OrganizationSwitcher />
        <nav aria-label="Primary">
          <p>Operations</p>
          {navigation.map(({ label, href, icon: Icon }, index) => (
            <Link
              className={index === 0 ? "nav-link nav-link--active" : "nav-link"}
              href={href}
              key={href}
            >
              <Icon aria-hidden="true" size={17} strokeWidth={1.7} />
              {label}
            </Link>
          ))}
          <p>Controls</p>
          <Link className="nav-link" href="/dashboard/rules">
            <BookOpenCheck aria-hidden="true" size={17} />
            Rules & tolerances
          </Link>
          <Link className="nav-link" href="/dashboard/security">
            <ShieldCheck aria-hidden="true" size={17} />
            Security
          </Link>
          <Link className="nav-link" href="/dashboard/settings">
            <Settings aria-hidden="true" size={17} />
            Settings
          </Link>
        </nav>
        <div className="sidebar__footer">
          <span>
            <Activity aria-hidden="true" size={15} />
            System status
          </span>
          <strong>Verify readiness</strong>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="environment-label">Development</span>
            <span className="read-only-label">No source writes</span>
          </div>
          <div className="topbar__actions">
            <span className="user-chip">
              <span aria-hidden="true">SO</span>
              Signed-in operator
            </span>
            <SignOutButton />
          </div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
