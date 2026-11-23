# Access control policy

**Owner:** `[system owner]`. **Applies to:** the SignuDoc install, and the Vercel team, Neon project, Resend account and GitHub repository behind it.

1. **Sign-in.** Staff sign in through `[identity provider]` single sign-on, with MFA enforced there. Password sign-in is off (`PASSWORD_SIGN_IN=off`) except for `[two]` named break-glass administrator accounts, which use two-step sign-in. Without single sign-on, two-step sign-in is required for everyone.
2. **Sessions** end after `[30]` minutes without use and at most `[12]` hours after sign-in.
3. **Who gets an account.** Sign-up is limited to `[our domains]`. With single sign-on, a person is given the app in `[identity provider]` by `[role]` on request from their manager.
4. **Administrators.** At most `[N]` people are administrators, named in `[location]`. A new administrator is approved by `[role]` and made one by an existing administrator; the change is in the site audit trail.
5. **Vendor consoles.** Only `[roles]` are members of the Vercel team, Neon project, Resend account and GitHub repository. Each uses their own login with MFA. Shared logins are not allowed.
6. **Leavers.** On a person's last day, `[role]` removes them in `[identity provider]` and from every vendor console, and checks People in the app. If they were an administrator, `[role]` takes the role away under People, which revokes the API keys they made.
7. **Review.** Every `[quarter]`, `[role]` compares People, the administrator list and each vendor console's members against current staff, removes anyone who should not be there, and files the result.
8. **Break-glass accounts** are used only when single sign-on is down. Each use is recorded as an incident, and the password is changed after.

**Evidence:** access reviews, identity provider assignment and removal logs, the site audit trail (`role_changed`, `sign_in_succeeded` with `method`).
