/**
 * The ONLY place CSS/DOM selectors for the Vodafone login live. Used solely by
 * the authenticator. When the portal changes its login form, only this file
 * changes. Values are verified against the real form by the smoke script.
 */
export const loginSelectors = {
  usernameInput: "input#username, input[name='username'], input[type='email']",
  passwordInput: "input#password, input[name='password'], input[type='password']",
  submitButton: "button[type='submit'], button#login-submit",
} as const;
