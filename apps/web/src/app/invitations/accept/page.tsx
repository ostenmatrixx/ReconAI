import { InvitationAcceptance } from "../../../components/invitation-acceptance";
import { readServerSessionToken } from "../../../server-session";

export const dynamic = "force-dynamic";

export default async function AcceptInvitationPage() {
  const session = await readServerSessionToken();
  return <InvitationAcceptance signedIn={Boolean(session)} />;
}
