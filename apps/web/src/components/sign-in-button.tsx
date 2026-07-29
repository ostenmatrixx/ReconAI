"use client";

import { LogIn } from "lucide-react";
import { signIn } from "next-auth/react";

export function SignInButton() {
  return (
    <button
      className="button button--primary"
      onClick={() => {
        void signIn("keycloak", { callbackUrl: "/dashboard" });
      }}
      type="button"
    >
      Sign in securely
      <LogIn aria-hidden="true" size={16} strokeWidth={1.8} />
    </button>
  );
}
