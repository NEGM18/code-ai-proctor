// =============================================================================
// ContactForm — the enquiry form.
//
// ⚠ IT DOES NOT PRETEND TO SEND. There is no contact endpoint in this project —
// no edge function, no Supabase table, no third-party form service. The
// tempting shape here is a submit handler that shows "Thanks, we'll be in
// touch!" and drops the message on the floor; that is a lie told to someone who
// is trying to reach a human, and it is the same class of failure as a gauge
// showing a number nobody measured.
//
// So submitting composes a real `mailto:` with the fields filled in and hands it
// to the visitor's mail client. The message genuinely goes somewhere, the
// visitor can see exactly what is being sent, and nothing is claimed that did
// not happen. When a backend endpoint exists, replace `buildMailto` with the
// POST — the validation and the field set do not change.
// =============================================================================

import { useState } from 'react';

const CONTACT_ADDRESS = 'hello@procminds.com';

const BLANK = { name: '', email: '', organization: '', message: '' };

function validate(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = 'Please tell us who you are.';
  // Deliberately permissive: an over-strict pattern rejects valid addresses
  // (plus-tags, new TLDs, unicode locals) and the mail client checks it anyway.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.email = 'A reachable email address, please.';
  }
  if (values.message.trim().length < 10) {
    errors.message = 'A sentence or two about what you need.';
  }
  return errors;
}

function buildMailto({ name, email, organization, message }) {
  const subject = `Procminds enquiry — ${organization || name}`;
  const body = [
    `Name: ${name}`,
    `Email: ${email}`,
    organization ? `Organisation: ${organization}` : null,
    '',
    message,
  ].filter((line) => line !== null).join('\n');

  return `mailto:${CONTACT_ADDRESS}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function Field({ id, label, error, children, hint }) {
  return (
    <p className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-slate-300">
        {label}
        {hint ? <span className="ml-1 font-normal text-slate-600">{hint}</span> : null}
      </label>
      {children}
      {error ? (
        <span id={`${id}-error`} role="alert" className="text-[11px] text-violation">
          {error}
        </span>
      ) : null}
    </p>
  );
}

const INPUT = 'rounded-md border border-slate-700 bg-surface/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-verified focus:outline-none';

export default function ContactForm() {
  const [values, setValues] = useState(BLANK);
  const [errors, setErrors] = useState({});
  const [handedOff, setHandedOff] = useState(false);

  const update = (key) => (event) => {
    setValues((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const onSubmit = (event) => {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setHandedOff(false);
      return;
    }
    window.location.href = buildMailto(values);
    setHandedOff(true);
  };

  return (
    <section id="contact" className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
      <div className="grid gap-10 lg:grid-cols-2 lg:items-start">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
            Talk to someone who built it
          </h2>
          <p className="mt-4 leading-relaxed text-slate-400">
            Deploying proctoring across an institution raises questions that a
            pricing table cannot answer — retention, appeals, accessibility,
            what happens when the system is wrong. Those are the interesting
            ones. Ask them.
          </p>
          <p className="mt-4 text-sm text-slate-500">
            Prefer email directly?{' '}
            <a href={`mailto:${CONTACT_ADDRESS}`} className="text-verified hover:underline">
              {CONTACT_ADDRESS}
            </a>
          </p>
        </div>

        <form onSubmit={onSubmit} noValidate className="glass rounded-card p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="contact-name" label="Name" error={errors.name}>
              <input
                id="contact-name"
                name="name"
                value={values.name}
                onChange={update('name')}
                aria-invalid={errors.name ? 'true' : undefined}
                aria-describedby={errors.name ? 'contact-name-error' : undefined}
                className={INPUT}
                autoComplete="name"
              />
            </Field>

            <Field id="contact-email" label="Email" error={errors.email}>
              <input
                id="contact-email"
                name="email"
                type="email"
                value={values.email}
                onChange={update('email')}
                aria-invalid={errors.email ? 'true' : undefined}
                aria-describedby={errors.email ? 'contact-email-error' : undefined}
                className={INPUT}
                autoComplete="email"
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field id="contact-org" label="Organisation" hint="optional">
              <input
                id="contact-org"
                name="organization"
                value={values.organization}
                onChange={update('organization')}
                className={INPUT}
                autoComplete="organization"
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field id="contact-message" label="What do you need?" error={errors.message}>
              <textarea
                id="contact-message"
                name="message"
                rows={4}
                value={values.message}
                onChange={update('message')}
                aria-invalid={errors.message ? 'true' : undefined}
                aria-describedby={errors.message ? 'contact-message-error' : undefined}
                className={`${INPUT} resize-y`}
              />
            </Field>
          </div>

          <button
            type="submit"
            className="mt-5 w-full rounded-md bg-verified px-4 py-2.5 text-sm font-semibold text-[var(--color-base)] transition hover:brightness-110"
          >
            Open this in my mail app
          </button>

          {/* Says exactly what the button did — not "message sent". */}
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500" aria-live="polite">
            {handedOff
              ? 'Handed to your mail client with the fields filled in. Nothing has been sent until you send it — and nothing was stored here.'
              : 'This composes an email in your own mail app. There is no form endpoint collecting this on our side.'}
          </p>
        </form>
      </div>
    </section>
  );
}
