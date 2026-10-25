import { Suspense } from "react";
import { cookies } from "next/headers";
import { getSession, INITIAL_HTML } from "@/lib/ui-store";
import GenerativeUI from "./generative-ui";

// Reads the session cookie, so it renders per request inside a Suspense boundary.
async function SessionUI() {
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
