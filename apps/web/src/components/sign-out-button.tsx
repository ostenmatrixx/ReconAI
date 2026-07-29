"use client";

import { LogOut } from "lucide-react";
import { getCsrfToken, signOut } from "next-auth/react";
import { useState } from "react";

export function SignOutButton() {
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);

    try {
      const csrfToken = await getCsrfToken();
      if (!csrfToken) throw new Error("CSRF token unavailable");

      const form = document.createElement("form");
      form.action = "/api/auth/federated-logout";
      form.method = "post";

      const tokenInput = document.createElement("input");
      tokenInput.name = "csrfToken";
      tokenInput.type = "hidden";
      tokenInput.value = csrfToken;
      form.append(tokenInput);
      document.body.append(form);
      form.submit();
    } catch {
      try {
        await signOut({ callbackUrl: "/" });
      } catch {
        setIsSigningOut(false);
      }
    }
  }

  return (
    <button
      className="icon-button"
      disabled={isSigningOut}
      onClick={() => {
        void handleSignOut();
      }}
      title={isSigningOut ? "Signing out" : "Sign out"}
      type="button"
    >
      <LogOut aria-hidden="true" size={17} />
      <span className="visually-hidden">{isSigningOut ? "Signing out" : "Sign out"}</span>
    </button>
  );
}
