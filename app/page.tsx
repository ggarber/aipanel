import { Suspense } from "react";
import { cookies } from "next/headers";
import { isAuthenticated } from "@/lib/auth";
import { getSession, INITIAL_HTML } from "@/lib/ui-store";
import GenerativeUI from "./generative-ui";
import LoginForm from "./login-form";

// Reads cookies, so it renders per request inside a Suspense boundary.
async function SessionUI() {
  if (!(await isAuthenticated())) return <LoginForm />;
  const id = (await cookies()).get("genui_session")?.value;
  const html = id ? getSession(id).html : INITIAL_HTML;
  return <GenerativeUI initialHtml={html} />;
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <SessionUI />
    </Suspense>
  );
}
