"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ApiError } from "@/lib/http";
import { authErrorText } from "@/lib/account";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthLayout, StateCard } from "@/components/auth/kit";

type State = { kind: "verifying" } | { kind: "verified"; email: string; pending: boolean } | { kind: "expired" } | { kind: "used" } | { kind: "invalid"; message: string };

export default function VerifyPage() {
  const { token } = useParams<{ token: string }>();
  const session = useSession();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "verifying" });
  const [sent, setSent] = useState(false);
  const ran = useRef(false);
  const signedIn = session.status === "signed-in";

  useEffect(() => {
    // The token is single use, so a strict-mode double effect must not spend it twice.
    if (ran.current) return;
    ran.current = true;
    session.account
      .verifyEmail(token)
      .then((r) => {
        setState({ kind: "verified", email: r.email, pending: r.status === "pending" });
        void session.refresh();
      })
      .catch((e) => {
        if (e instanceof ApiError && e.code === "TOKEN_EXPIRED") setState({ kind: "expired" });
        else if (e instanceof ApiError && e.code === "TOKEN_USED") setState({ kind: "used" });
        else setState({ kind: "invalid", message: authErrorText(e, "This link is not valid.") });
      });
  }, [session, token]);

  const resend = async () => {
    try {
      await session.account.resendVerification();
      setSent(true);
      toast.success("A new link is on its way.");
    } catch (e) {
      toast.error(authErrorText(e));
    }
  };

  const goOn = (pending: boolean) => router.replace(signedIn ? (pending ? "/signup/pending" : "/") : "/login");

  return (
    <AuthLayout>
      {state.kind === "verifying" && <StateCard tone="neutral" title="Verifying your email" />}
      {state.kind === "verified" && (
        <StateCard tone="positive" title="Email verified" action={<Button onClick={() => goOn(state.pending)}>{signedIn ? "Continue" : "Sign in"}</Button>}>
          <span className="font-medium text-foreground">{state.email}</span> is confirmed.
          {state.pending ? " Your business now waits for the platform owner to approve it." : " You can now use every part of your account."}
        </StateCard>
      )}
      {state.kind === "expired" && (
        <StateCard
          tone="negative"
          title="This link has expired"
          action={
            signedIn ? (
              <Button onClick={() => void resend()} disabled={sent}>
                {sent ? "Link sent" : "Send a new link"}
              </Button>
            ) : (
              <Button asChild>
                <Link href="/login">Sign in to get a new link</Link>
              </Button>
            )
          }
        >
          Verification links work for 48 hours.
        </StateCard>
      )}
      {state.kind === "used" && (
        <StateCard
          tone="info"
          title="This link was already used"
          action={
            <Button asChild>
              <Link href={signedIn ? "/" : "/login"}>{signedIn ? "Go to Home" : "Sign in"}</Link>
            </Button>
          }
        >
          Your email may already be verified. Sign in to check.
        </StateCard>
      )}
      {state.kind === "invalid" && (
        <StateCard
          tone="negative"
          title="This link is not valid"
          action={
            <Button asChild variant="outline">
              <Link href={signedIn ? "/" : "/login"}>{signedIn ? "Go to Home" : "Back to sign in"}</Link>
            </Button>
          }
        >
          {state.message}
        </StateCard>
      )}
    </AuthLayout>
  );
}
