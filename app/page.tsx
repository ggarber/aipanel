import { Suspense } from "react";
import { isAuthenticated } from "@/lib/auth";
import Home from "./home";
import LoginForm from "./login-form";

async function Gate() {
  return (await isAuthenticated()) ? <Home /> : <LoginForm />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Gate />
    </Suspense>
  );
}
