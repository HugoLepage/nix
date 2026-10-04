// Login screen: one form that signs in or creates the account, whichever applies.

import { signIn } from '../auth.js';
import { $, shake } from './dom.js';

/** Error code → [message, field to flag]. Messages stay terse: a couple of words that say what to fix. */
function describe(error) {
  switch (error) {
    case 'username':
      return ['3–16 letters, digits', 'username'];
    case 'password-format':
      return ['4–64 characters', 'password'];
    case 'password':
      return ['Wrong password', 'password'];
    default:
      return ['No connection', null];
  }
}

export function createLogin(root, { onSignedIn }) {
  const form = $('#login-form', root);
  const fields = { username: $('#login-username', root), password: $('#login-password', root) };
  const submit = $('#login-submit', root);
  const message = $('#login-error', root);
  let busy = false;

  function clearError() {
    message.textContent = '';
    for (const input of Object.values(fields)) input.removeAttribute('aria-invalid');
  }

  function fail(error) {
    const [text, fieldName] = describe(error);
    message.textContent = text;
    shake(form);
    const field = fields[fieldName];
    if (!field) return;
    field.setAttribute('aria-invalid', 'true');
    field.focus({ preventScroll: true });
    field.select();
  }

  function setBusy(value) {
    busy = value;
    submit.setAttribute('aria-busy', String(value));
    for (const input of Object.values(fields)) input.readOnly = value;
  }

  form.addEventListener('input', clearError);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    // Enter (the phone keyboard's "next") on the name moves on to the password instead of failing on it.
    if (document.activeElement === fields.username && fields.password.value === '') {
      fields.password.focus({ preventScroll: true });
      return;
    }
    clearError();
    setBusy(true);
    const result = await signIn(fields.username.value, fields.password.value);
    setBusy(false);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    form.reset();
    onSignedIn(result);
  });
}
