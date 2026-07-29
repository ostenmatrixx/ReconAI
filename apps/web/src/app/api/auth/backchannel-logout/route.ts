import { type NextRequest } from "next/server";

import { readOidcEnvironment } from "../../../../oidc-environment";
import {
  handleOidcBackchannelLogout,
  oidcLogoutKeyResolver,
} from "../../../../oidc-backchannel-logout";
import { sessionRevocationStore } from "../../../../session-revocation";
import { readSessionRevocationConfiguration } from "../../../../server-environment";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  const oidc = readOidcEnvironment();
  const revocation = readSessionRevocationConfiguration();
  return handleOidcBackchannelLogout(request, oidc, sessionRevocationStore(revocation), {
    keyResolver: oidcLogoutKeyResolver(oidc),
    onFailure(classification) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "reconai-web",
          environment: revocation.environment,
          event: "oidc_backchannel_logout_failed",
          classification,
        }),
      );
    },
  });
}
