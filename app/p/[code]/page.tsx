import { Suspense } from "react";
import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { isPanelCode, normalizeCode } from "@/lib/panel-code";
import LoginForm from "../../login-form";
import PanelView from "../../panel-view";

async function Gate({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = normalizeCode(decodeURIComponent(raw));
  if (!isPanelCode(code)) redirect("/");
  if (code !== raw) redirect(`/p/${code}`);
  if (!(await isAuthenticated())) return <LoginForm next={`/p/${code}`} />;
  return <PanelView code={code} />;
}

export default function Page({ params }: { params: Promise<{ code: string }> }) {
  return (
    <Suspense fallback={null}>
      <Gate params={params} />
    </Suspense>
  );
}
