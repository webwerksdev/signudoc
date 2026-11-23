"use client";

import Link from "next/link";
import {
  useState,
  type ChangeEvent,
  type ChangeEventHandler,
  type FormEvent,
} from "react";

import { SsoButton, type SsoOption } from "@/components/auth/sso-button";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { authClient } from "@/lib/auth/client";
import {
  describePasswordRefusal,
  newPasswordLengthError,
  PASSWORD_TOO_SHORT_MESSAGE,
} from "@/lib/password-messages";
import { signUpSchema } from "@/lib/schemas/auth";

const defaultSuccessMessage = "Check your email to verify your sender account.";
// With no email provider connected, the verification email cannot be sent.
// Logging in sends it again, so that works once email is set up.
const SIGNUP_EMAIL_NOT_CONNECTED_MESSAGE =
  "Your account is created, but this site can't send email yet, so the email that verifies your address couldn't be sent. Ask an administrator to finish email setup in Settings, Organization. Once it's set up, log in and the verification email will be sent.";

type AuthErrorLike = {
  code?: string;
  message?: string;
};

// Codes the server answers with when this install's sign-up rule turns an
// address away. The message that comes with them says what the rule is.
const SIGNUP_RULE_ERROR_CODES = new Set([
  "setup_required",
  "signup_closed",
  "signup_domain_not_allowed",
]);

type SignupShellProps = {
  /** False when the install has no email provider to send with. */
  emailConnected?: boolean;
  /** False when password sign-in is turned off, so accounts come from SSO. */
  passwordSignIn?: boolean;
  /** Single sign-on, when the install has it (lib/auth/sso.ts). */
  sso?: SsoOption | null;
  /** False when this install is not taking new accounts at all. */
  signupAvailable?: boolean;
  /** One sentence on who can create an account, or null when anyone can. */
  signupRule?: string | null;
};

type SignupFormValues = {
  email: string;
  fullName: string;
  password: string;
};

type SignupFormErrors = Partial<Record<keyof SignupFormValues, string>>;

function createSignupFormValues(): SignupFormValues {
  return {
    email: "",
    fullName: "",
    password: "",
  };
}

function trimFormValues(values: SignupFormValues): SignupFormValues {
  return {
    email: values.email.trim(),
    fullName: values.fullName.trim(),
    password: values.password,
  };
}

function normalizeAuthErrorMessage(
  error: AuthErrorLike | null | undefined,
): string {
  return error?.message?.trim().toLowerCase() ?? "";
}

type SignupFormCardProps = {
  bannerMessage: string | null;
  errors: SignupFormErrors;
  formLocked: boolean;
  isResendingVerification?: boolean;
  isSubmitting: boolean;
  onEmailChange: ChangeEventHandler<HTMLInputElement>;
  onFullNameChange: ChangeEventHandler<HTMLInputElement>;
  onPasswordChange: ChangeEventHandler<HTMLInputElement>;
  onResendVerification?: () => void | Promise<void>;
  onSsoError: (message: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  passwordSignIn: boolean;
  showSuccess: boolean;
  signupRule: string | null;
  sso: SsoOption | null;
  successMessage: string | null;
  values: SignupFormValues;
};

function SignupFormCard({
  bannerMessage,
  errors,
  formLocked,
  isResendingVerification = false,
  isSubmitting,
  onEmailChange,
  onFullNameChange,
  onPasswordChange,
  onResendVerification,
  onSsoError,
  onSubmit,
  passwordSignIn,
  showSuccess,
  signupRule,
  sso,
  successMessage,
  values,
}: SignupFormCardProps) {
  return (
    <section className="panel w-full max-w-[460px] p-8 sm:p-10">
      <div className="space-y-7">
        <div className="space-y-2">
          <p className="section-eyebrow">Create account</p>
          <h1 className="text-[clamp(1.875rem,4.5vw,2.375rem)] font-extrabold leading-[1.08] tracking-[-0.035em] text-(--fg)">
            Create your account
          </h1>
          {signupRule ? (
            <p className="pt-1 text-sm leading-6 text-muted-foreground">
              {signupRule}
            </p>
          ) : null}
        </div>

        {bannerMessage ? (
          <p className="notice notice-danger" role="alert">
            {bannerMessage}
          </p>
        ) : null}

        {showSuccess ? (
          <div aria-live="polite" className="notice notice-success">
            <p>{successMessage ?? defaultSuccessMessage}</p>
          </div>
        ) : null}

        {sso ? (
          <SsoButton
            onError={onSsoError}
            sso={sso}
            variant={passwordSignIn ? "secondary" : "primary"}
          />
        ) : null}

        {sso && passwordSignIn ? (
          <p className="text-center text-xs font-semibold uppercase tracking-[0.12em] text-(--secondary)">
            or
          </p>
        ) : null}

        {passwordSignIn ? (
          <form className="space-y-5" noValidate onSubmit={onSubmit}>
            <FieldShell
              autoComplete="name"
              disabled={formLocked}
              error={errors.fullName}
              label="Full name"
              name="signup-full-name"
              onChange={onFullNameChange}
              placeholder="Jane Smith"
              readOnly={formLocked}
              value={values.fullName}
            />
            <FieldShell
              autoComplete="email"
              disabled={formLocked}
              error={errors.email}
              label="Email"
              name="signup-email"
              onChange={onEmailChange}
              placeholder="jane@acmecorp.com"
              readOnly={formLocked}
              type="email"
              value={values.email}
            />
            <FieldShell
              autoComplete="new-password"
              disabled={formLocked}
              error={errors.password}
              helper="Must be at least 15 characters"
              label="Password"
              name="signup-password"
              onChange={onPasswordChange}
              placeholder="Enter a password"
              readOnly={formLocked}
              type="password"
              value={values.password}
            />

            {showSuccess ? (
              <div className="flex flex-col gap-3">
                <ShellButton className="w-full" href="/login" variant="primary">
                  Go to log in
                </ShellButton>
                {onResendVerification ? (
                  <ShellButton
                    className="w-full"
                    disabled={formLocked}
                    loading={isResendingVerification}
                    onClick={onResendVerification}
                    type="button"
                    variant="secondary"
                  >
                    {isResendingVerification
                      ? "Sending..."
                      : "Resend verification email"}
                  </ShellButton>
                ) : null}
              </div>
            ) : (
              <ShellButton
                className="w-full"
                disabled={formLocked}
                loading={isSubmitting}
                type="submit"
                variant="primary"
              >
                {isSubmitting ? "Creating account..." : "Sign up"}
              </ShellButton>
            )}
          </form>
        ) : null}

        <div className="border-t border-(--border) pt-5 text-sm text-(--secondary)">
          Already have an account?{" "}
          <Link
            className="font-bold text-(--accent-ink) underline-offset-4 hover:underline"
            href="/login"
          >
            Log in
          </Link>
        </div>
      </div>
    </section>
  );
}

export function SignupShell({
  emailConnected = true,
  passwordSignIn = true,
  signupAvailable = true,
  signupRule = null,
  sso = null,
}: SignupShellProps) {
  if (!signupAvailable) {
    return <SignupClosedCard />;
  }

  return (
    <LiveSignupShell
      emailConnected={emailConnected}
      passwordSignIn={passwordSignIn || !sso}
      signupRule={signupRule}
      sso={sso}
    />
  );
}

function SignupClosedCard() {
  return (
    <section className="panel w-full max-w-[460px] p-8 sm:p-10">
      <div className="space-y-7">
        <div className="space-y-2">
          <p className="section-eyebrow">Create account</p>
          <h1 className="text-[clamp(1.875rem,4.5vw,2.375rem)] font-extrabold leading-[1.08] tracking-[-0.035em] text-(--fg)">
            Sign-up is closed
          </h1>
          <p className="pt-1 text-sm leading-6 text-muted-foreground">
            New accounts are not being accepted on this site. If you were sent a
            document to sign, use the link in that email. You do not need an
            account.
          </p>
        </div>
        <ShellButton className="w-full" href="/login" variant="primary">
          Go to log in
        </ShellButton>
      </div>
    </section>
  );
}

function LiveSignupShell({
  emailConnected,
  passwordSignIn,
  signupRule,
  sso,
}: {
  emailConnected: boolean;
  passwordSignIn: boolean;
  signupRule: string | null;
  sso: SsoOption | null;
}) {
  const [values, setValues] = useState<SignupFormValues>(
    createSignupFormValues(),
  );
  const [errors, setErrors] = useState<SignupFormErrors>({});
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [successEmail, setSuccessEmail] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function handleChange(field: keyof SignupFormValues) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;

      setValues((currentValues) => ({
        ...currentValues,
        [field]: nextValue,
      }));

      setErrors((currentErrors) => ({
        ...currentErrors,
        [field]: undefined,
      }));
      setBannerMessage(null);
      setShowSuccess(false);
      setSuccessMessage(null);
    };
  }

  async function handleResendVerification() {
    if (!successEmail || isResendingVerification) {
      return;
    }

    setBannerMessage(null);
    setIsResendingVerification(true);

    try {
      const response = await fetch("/api/auth/send-verification-email", {
        body: JSON.stringify({
          callbackURL: `${window.location.origin}/dashboard`,
          email: successEmail,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        setBannerMessage("We couldn't resend the verification email.");
        return;
      }

      setSuccessMessage("Verification email sent. Check your inbox.");
    } catch {
      setBannerMessage("We couldn't resend the verification email.");
    } finally {
      setIsResendingVerification(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting || isResendingVerification) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const trimmedValues = trimFormValues({
      email: String(formData.get("signup-email") ?? values.email),
      fullName: String(formData.get("signup-full-name") ?? values.fullName),
      password: String(formData.get("signup-password") ?? values.password),
    });
    const validationResult = signUpSchema.safeParse(trimmedValues);

    if (!validationResult.success) {
      const nextErrors: SignupFormErrors = {};

      for (const issue of validationResult.error.issues) {
        const field = issue.path[0];

        if (field === "email") {
          nextErrors.email = "Enter a valid email address";
        }

        if (field === "fullName") {
          nextErrors.fullName = "Enter your full name";
        }

        if (field === "password") {
          nextErrors.password =
            newPasswordLengthError(trimmedValues.password) ??
            PASSWORD_TOO_SHORT_MESSAGE;
        }
      }

      setValues(trimmedValues);
      setErrors(nextErrors);
      setBannerMessage(null);
      setShowSuccess(false);
      setSuccessMessage(null);
      return;
    }

    setValues(validationResult.data);
    setErrors({});
    setBannerMessage(null);
    setShowSuccess(false);
    setSuccessMessage(null);
    setIsSubmitting(true);

    const result = await authClient.signUp.email({
      callbackURL: `${window.location.origin}/dashboard`,
      email: validationResult.data.email,
      name: validationResult.data.fullName,
      password: validationResult.data.password,
    });

    if (result.error) {
      const normalizedErrorMessage = normalizeAuthErrorMessage(result.error);

      if (SIGNUP_RULE_ERROR_CODES.has(result.error.code ?? "")) {
        setBannerMessage(
          result.error.message ?? "New accounts are not being accepted.",
        );
      } else if (
        normalizedErrorMessage.includes("user already exists") ||
        normalizedErrorMessage.includes("use another email")
      ) {
        setErrors({
          email: "This email is already registered",
        });
      } else if (describePasswordRefusal(result.error)) {
        setErrors({
          password: describePasswordRefusal(result.error)!,
        });
      } else {
        setBannerMessage("Something went wrong. Please try again.");
      }

      setIsSubmitting(false);
      return;
    }

    setSuccessEmail(validationResult.data.email);
    // With no email provider the confirmation email cannot have gone, so
    // the sender is not told to wait for it (issue #95).
    setSuccessMessage(
      emailConnected
        ? defaultSuccessMessage
        : SIGNUP_EMAIL_NOT_CONNECTED_MESSAGE,
    );
    setShowSuccess(true);
    setIsSubmitting(false);
  }

  return (
    <SignupFormCard
      bannerMessage={bannerMessage}
      errors={errors}
      formLocked={isSubmitting || isResendingVerification}
      isResendingVerification={isResendingVerification}
      isSubmitting={isSubmitting}
      onEmailChange={handleChange("email")}
      onFullNameChange={handleChange("fullName")}
      onPasswordChange={handleChange("password")}
      onResendVerification={
        emailConnected ? handleResendVerification : undefined
      }
      onSsoError={setBannerMessage}
      onSubmit={handleSubmit}
      passwordSignIn={passwordSignIn}
      showSuccess={showSuccess}
      signupRule={signupRule}
      sso={sso}
      successMessage={successMessage}
      values={values}
    />
  );
}
