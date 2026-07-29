import { notFound } from "next/navigation";

import { ExceptionWorkspace } from "../../../../components/exception-workspace";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export default async function ExceptionPage({
  params,
}: {
  readonly params: Promise<{ readonly exceptionId: string }>;
}) {
  const { exceptionId } = await params;
  if (!uuidPattern.test(exceptionId)) notFound();
  return <ExceptionWorkspace exceptionId={exceptionId} />;
}
