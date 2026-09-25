"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import {
  APPLICATION_CONTEXTS,
  APPLICATION_LIMITS,
  DEPLOYMENT_PREFERENCES,
  DESIGN_PARTNER_ANSWERS,
  EVALUATION_TIMELINES,
  MARKETING_CONSENT_TEXT,
  MARKETING_CONSENT_VERSION,
  PRIVACY_NOTICE_VERSION,
  parseApplicationSubmission,
  type ApplicationField,
} from "../../application/contract";

const NO_SECRETS =
  "Do not include passwords, API keys, credentials, personal data about others, or confidential customer information.";

type FormState = Record<ApplicationField, string | boolean>;

function operationKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function initialState(): FormState {
  return {
    operationKey: operationKey(),
    name: "",
    email: "",
    roleFunction: "",
    context: "",
    organization: "",
    intendedUseCase: "",
    workflowStage: "",
    deploymentPreference: "",
    evaluationTimeline: "",
    designPartnerWillingness: "",
    integrationConstraints: "",
    referralSource: "",
    additionalContext: "",
    privacyAcknowledged: false,
    marketingSelected: false,
    companyWebsite: "",
  };
}

function TextHelp({ id, maximum }: { id: string; maximum: number }) {
  return (
    <span className="field-help" id={id}>
      {NO_SECRETS} Maximum {maximum.toLocaleString("en-US")} characters.
    </span>
  );
}

function ErrorText({
  field,
  message,
}: {
  field: ApplicationField;
  message?: string;
}) {
  return message ? (
    <span className="field-error" id={`${field}-error`}>
      {message}
    </span>
  ) : null;
}

export function ApplicationForm() {
  const [form, setForm] = useState<FormState>(() => initialState());
  const [errors, setErrors] = useState<
    Partial<Record<ApplicationField | "request", string>>
  >({});
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const errorSummary = useRef<HTMLDivElement>(null);
  const organizationRequired =
    form.context === "Work" || form.context === "Both";
  const errorEntries = useMemo(() => Object.entries(errors), [errors]);

  function update(field: ApplicationField, value: string | boolean) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function describedBy(
    field: ApplicationField,
    help?: string,
  ): string | undefined {
    return (
      [help, errors[field] ? `${field}-error` : null]
        .filter(Boolean)
        .join(" ") || undefined
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("");
    const parsed = parseApplicationSubmission(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      requestAnimationFrame(() => errorSummary.current?.focus());
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = (await response.json()) as {
        message?: string;
        errors?: Partial<Record<ApplicationField | "request", string>>;
      };
      if (!response.ok && result.errors) {
        setErrors(result.errors);
        requestAnimationFrame(() => errorSummary.current?.focus());
      } else {
        setStatus(
          result.message ??
            "If the request is eligible, an email with the next step will be sent.",
        );
      }
    } catch {
      setStatus(
        "The request could not be completed. You can try again safely.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="application-form"
      id="application-form"
      noValidate
      onSubmit={submit}
    >
      {errorEntries.length > 0 ? (
        <div
          className="error-summary"
          ref={errorSummary}
          role="alert"
          tabIndex={-1}
        >
          <h2>Check the application</h2>
          <p>
            Correct the fields identified below. Nothing has been submitted.
          </p>
          <ul>
            {errorEntries.map(([field, message]) => (
              <li key={field}>
                {field === "request" ? (
                  message
                ) : (
                  <a
                    href={`#${
                      field === "operationKey"
                        ? "application-form"
                        : field === "context"
                          ? "context-Work"
                          : field === "designPartnerWillingness"
                            ? "designPartnerWillingness-Yes"
                            : field
                    }`}
                  >
                    {message}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="required-note">
        All fields marked “Required” must be completed.
      </p>
      <div className="form-grid">
        <div className="form-field">
          <label htmlFor="name">
            Name <span>Required</span>
          </label>
          <TextHelp id="name-help" maximum={APPLICATION_LIMITS.name} />
          <input
            id="name"
            name="name"
            autoComplete="name"
            required
            value={form.name as string}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={describedBy("name", "name-help")}
            onChange={(event) => update("name", event.target.value)}
          />
          <ErrorText field="name" message={errors.name} />
        </div>

        <div className="form-field">
          <label htmlFor="email">
            Email <span>Required</span>
          </label>
          <TextHelp id="email-help" maximum={APPLICATION_LIMITS.email} />
          <input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={form.email as string}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={describedBy("email", "email-help")}
            onChange={(event) => update("email", event.target.value)}
          />
          <ErrorText field="email" message={errors.email} />
        </div>

        <div className="form-field">
          <label htmlFor="roleFunction">
            Role or function <span>Required</span>
          </label>
          <TextHelp
            id="roleFunction-help"
            maximum={APPLICATION_LIMITS.roleFunction}
          />
          <input
            id="roleFunction"
            name="roleFunction"
            autoComplete="organization-title"
            required
            value={form.roleFunction as string}
            aria-invalid={Boolean(errors.roleFunction)}
            aria-describedby={describedBy("roleFunction", "roleFunction-help")}
            onChange={(event) => update("roleFunction", event.target.value)}
          />
          <ErrorText field="roleFunction" message={errors.roleFunction} />
        </div>

        <fieldset
          id="context"
          className="form-field form-field-full"
          aria-describedby={errors.context ? "context-error" : undefined}
          aria-invalid={Boolean(errors.context)}
        >
          <legend>
            Is this for work, personal use, or both? <span>Required</span>
          </legend>
          <div className="choice-row">
            {APPLICATION_CONTEXTS.map((value) => (
              <label key={value}>
                <input
                  id={`context-${value}`}
                  type="radio"
                  name="context"
                  value={value}
                  checked={form.context === value}
                  onChange={(event) => update("context", event.target.value)}
                />{" "}
                {value}
              </label>
            ))}
          </div>
          <ErrorText field="context" message={errors.context} />
        </fieldset>

        <div className="form-field form-field-full">
          <label htmlFor="organization">
            Company or organization{" "}
            <span>{organizationRequired ? "Required" : "Optional"}</span>
          </label>
          <TextHelp
            id="organization-help"
            maximum={APPLICATION_LIMITS.organization}
          />
          <input
            id="organization"
            name="organization"
            autoComplete="organization"
            required={organizationRequired}
            value={form.organization as string}
            aria-invalid={Boolean(errors.organization)}
            aria-describedby={describedBy("organization", "organization-help")}
            onChange={(event) => update("organization", event.target.value)}
          />
          <ErrorText field="organization" message={errors.organization} />
        </div>

        <div className="form-field form-field-full">
          <label htmlFor="intendedUseCase">
            Intended Fidensa use case <span>Required</span>
          </label>
          <TextHelp
            id="intendedUseCase-help"
            maximum={APPLICATION_LIMITS.intendedUseCase}
          />
          <textarea
            id="intendedUseCase"
            name="intendedUseCase"
            required
            value={form.intendedUseCase as string}
            aria-invalid={Boolean(errors.intendedUseCase)}
            aria-describedby={describedBy(
              "intendedUseCase",
              "intendedUseCase-help",
            )}
            onChange={(event) => update("intendedUseCase", event.target.value)}
          />
          <span className="character-count">
            {Array.from(form.intendedUseCase as string).length} /{" "}
            {APPLICATION_LIMITS.intendedUseCase}
          </span>
          <ErrorText field="intendedUseCase" message={errors.intendedUseCase} />
        </div>

        <div className="form-field form-field-full">
          <label htmlFor="workflowStage">
            Agent or workflow stage <span>Required</span>
          </label>
          <TextHelp
            id="workflowStage-help"
            maximum={APPLICATION_LIMITS.workflowStage}
          />
          <textarea
            id="workflowStage"
            name="workflowStage"
            required
            value={form.workflowStage as string}
            aria-invalid={Boolean(errors.workflowStage)}
            aria-describedby={describedBy(
              "workflowStage",
              "workflowStage-help",
            )}
            onChange={(event) => update("workflowStage", event.target.value)}
          />
          <span className="character-count">
            {Array.from(form.workflowStage as string).length} /{" "}
            {APPLICATION_LIMITS.workflowStage}
          </span>
          <ErrorText field="workflowStage" message={errors.workflowStage} />
        </div>

        <div className="form-field">
          <label htmlFor="deploymentPreference">
            Deployment preference <span>Required</span>
          </label>
          <select
            id="deploymentPreference"
            name="deploymentPreference"
            required
            value={form.deploymentPreference as string}
            aria-invalid={Boolean(errors.deploymentPreference)}
            aria-describedby={describedBy("deploymentPreference")}
            onChange={(event) =>
              update("deploymentPreference", event.target.value)
            }
          >
            <option value="">Choose one</option>
            {DEPLOYMENT_PREFERENCES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <ErrorText
            field="deploymentPreference"
            message={errors.deploymentPreference}
          />
        </div>

        <div className="form-field">
          <label htmlFor="evaluationTimeline">
            Evaluation timeline <span>Required</span>
          </label>
          <select
            id="evaluationTimeline"
            name="evaluationTimeline"
            required
            value={form.evaluationTimeline as string}
            aria-invalid={Boolean(errors.evaluationTimeline)}
            aria-describedby={describedBy("evaluationTimeline")}
            onChange={(event) =>
              update("evaluationTimeline", event.target.value)
            }
          >
            <option value="">Choose one</option>
            {EVALUATION_TIMELINES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <ErrorText
            field="evaluationTimeline"
            message={errors.evaluationTimeline}
          />
        </div>

        <fieldset
          id="designPartnerWillingness"
          className="form-field form-field-full"
          aria-describedby={describedBy(
            "designPartnerWillingness",
            "design-help",
          )}
          aria-invalid={Boolean(errors.designPartnerWillingness)}
        >
          <legend>
            Would you consider being a design partner?{" "}
            <span>Required answer; agreement is not required</span>
          </legend>
          <p className="field-help" id="design-help">
            Choose the answer that best reflects your current interest.
          </p>
          <div className="choice-row">
            {DESIGN_PARTNER_ANSWERS.map((value) => (
              <label key={value}>
                <input
                  id={`designPartnerWillingness-${value}`}
                  type="radio"
                  name="designPartnerWillingness"
                  value={value}
                  checked={form.designPartnerWillingness === value}
                  onChange={(event) =>
                    update("designPartnerWillingness", event.target.value)
                  }
                />{" "}
                {value}
              </label>
            ))}
          </div>
          <ErrorText
            field="designPartnerWillingness"
            message={errors.designPartnerWillingness}
          />
        </fieldset>

        {(
          [
            [
              "integrationConstraints",
              "Integration or environment constraints",
              APPLICATION_LIMITS.integrationConstraints,
            ],
            [
              "referralSource",
              "How did you hear about Fidensa?",
              APPLICATION_LIMITS.referralSource,
            ],
            [
              "additionalContext",
              "Additional context",
              APPLICATION_LIMITS.additionalContext,
            ],
          ] as const
        ).map(([field, label, maximum]) => (
          <div className="form-field form-field-full" key={field}>
            <label htmlFor={field}>
              {label} <span>Optional</span>
            </label>
            <TextHelp id={`${field}-help`} maximum={maximum} />
            <textarea
              id={field}
              name={field}
              value={form[field] as string}
              aria-invalid={Boolean(errors[field])}
              aria-describedby={describedBy(field, `${field}-help`)}
              onChange={(event) => update(field, event.target.value)}
            />
            <span className="character-count">
              {Array.from(form[field] as string).length} / {maximum}
            </span>
            <ErrorText field={field} message={errors[field]} />
          </div>
        ))}
      </div>

      <div className="honeypot" aria-hidden="true">
        <label htmlFor="companyWebsite">Company website</label>
        <input
          id="companyWebsite"
          name="companyWebsite"
          autoComplete="off"
          tabIndex={-1}
          value={form.companyWebsite as string}
          onChange={(event) => update("companyWebsite", event.target.value)}
        />
      </div>

      <fieldset className="consent-panel">
        <legend>Privacy and updates</legend>
        <label className="check-row">
          <input
            id="privacyAcknowledged"
            type="checkbox"
            name="privacyAcknowledged"
            required
            checked={form.privacyAcknowledged as boolean}
            aria-invalid={Boolean(errors.privacyAcknowledged)}
            aria-describedby={
              errors.privacyAcknowledged
                ? "privacyAcknowledged-error"
                : undefined
            }
            onChange={(event) =>
              update("privacyAcknowledged", event.target.checked)
            }
          />
          <span>
            I have read the{" "}
            <Link href="/privacy" data-notice-version={PRIVACY_NOTICE_VERSION}>
              Privacy Notice
            </Link>
            . <strong>Required acknowledgment.</strong> This is not consent to
            marketing.
          </span>
        </label>
        <ErrorText
          field="privacyAcknowledged"
          message={errors.privacyAcknowledged}
        />
        <label className="check-row">
          <input
            id="marketingSelected"
            type="checkbox"
            name="marketingSelected"
            checked={form.marketingSelected as boolean}
            data-consent-version={MARKETING_CONSENT_VERSION}
            onChange={(event) =>
              update("marketingSelected", event.target.checked)
            }
          />
          <span>
            {MARKETING_CONSENT_TEXT} Optional and unchecked by default.
          </span>
        </label>
      </fieldset>

      <button className="primary-button" type="submit" disabled={submitting}>
        {submitting ? "Submitting…" : "Submit application"}
      </button>
      <p className="form-status" role="status" aria-live="polite">
        {status}
      </p>
    </form>
  );
}
