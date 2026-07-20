/**
 * The ONLY place CSS/DOM selectors for the Vodafone login live. Used solely by
 * the authenticator. When the portal changes its login form, only this file
 * changes. Values are verified against the real form by the smoke script.
 */
export const loginSelectors = {
  cookieRejectButton: "button#dip-consent-summary-reject-all",
  usernameInput:
    "input#username, input#username-text, input[name='username'], input[name='username-text'], input[type='email']",
  passwordInput:
    "input#password, input#passwordField-input, input[name='password'], input[name='passwordField'], input[type='password']",
  submitButton: "button#submit, button[type='submit'], button#login-submit",
} as const;
