"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Hourglass, LogOut, RefreshCw } from "lucide-react";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthLayout, StateCard } from "@/components/auth/kit";

const POLL_MS = 15_000;

/** Waiting for approval (docs/PRODUCT.md section 4.8): the request sits with the platform owner until approved. */
export default function SignupPendingPage() {
  const session = useSession();
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const user = session.status === "signed-in" ? session.session.user : null;
  const request = session.status === "signed-in" ? session.session.signupRequest : null;
  const status = request?.status === "declined" ? "disabled" : user?.status ?? null;

  useEffect(() => {
    if (session.status === "signed-out") router.replace("/login?next=/signup/pending");
  }, [session.status, router]);

  useEffect(() => {
    if (status !== "pending") return;
    const t = window.setInterval(() => void session.refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [status, session]);

  const check = async () => {
    setChecking(true);
    await session.refresh();
    setChecking(false);
  };
  const signOut = async () => {
    await session.signOut();
    router.replace("/login?reason=signed_out");
  };

  if (status === "active") {
    return (
      <AuthLayout>
        <StateCard tone="positive" title="Your business was approved" action={<Button onClick={() => router.replace("/")}>Continue</Button>}>
          You can now set your payout wallet and start taking payments.
        </StateCard>
      </AuthLayout>
    );
  }
  if (status === "disabled") {
    return (
      <AuthLayout>
        <StateCard
          tone="negative"
          title="Your sign-up was declined"
          action={
            <Button variant="outline" onClick={() => void signOut()}>
              <LogOut aria-hidden /> Sign out
            </Button>
          }
        >
          {request?.reason ? (
            <>
              The platform owner did not approve {request.businessName ?? "this business"}: <span className="font-medium text-foreground">{request.reason}</span>
            </>
          ) : (
            "The platform owner did not approve this business. The email we sent you explains why."
          )}{" "}
          Reply to that email if you think this is a mistake.
        </StateCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <section className="rounded-xl border bg-card p-6 text-center shadow-xs">
        <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-warning-soft text-warning">
          <Hourglass className="size-5" aria-hidden />
        </span>
        <h1 className="mt-4 text-lg font-semibold tracking-[-0.01em]">Waiting for approval</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          The platform owner reviews every new business on this server. We will email {user?.email ? <span className="font-medium text-foreground">{user.email}</span> : "you"} once it is approved. This page checks again every 15 seconds.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <Button variant="outline" onClick={() => void check()} disabled={checking}>
            <RefreshCw className={checking ? "animate-spin" : undefined} aria-hidden /> Check now
          </Button>
          <Button variant="ghost" onClick={() => void signOut()}>
            <LogOut aria-hidden /> Sign out
          </Button>
        </div>
      </section>
    </AuthLayout>
  );
}
