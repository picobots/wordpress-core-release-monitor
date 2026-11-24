# WordPress Core Release Monitor

A small Google Apps Script that watches official WordPress.org sources and
sends email alerts when a WordPress Core release is being prepared, becomes
available, or receives an official security announcement.

It was created to provide an earlier, quieter signal than waiting for a news
post while avoiding an email for every historical branch backport.

## What it monitors

- [Development SVN tags](https://develop.svn.wordpress.org/tags/) for an
  optional early warning that official release preparation is underway.
- The [WordPress release archive](https://wordpress.org/download/releases/)
  for confirmation that a stable package is available.
- The [WordPress security feed](https://wordpress.org/news/category/security/feed/)
  for official security announcements and context.

The script ignores beta, release candidate, and nightly builds. A stable
package or tag does not, by itself, prove that a release contains a security
fix.

## Notification behavior

The default policy favors meaningful events over exhaustive branch mail:

- A new stable SVN tag can produce one pre-release warning.
- A new release on the latest stable branch produces an availability alert.
- Older-branch backports are tracked silently by default.
- A later official security announcement produces its own alert.
- A failed request is retried once, and transient one-off failures are silent.
- A persistent endpoint failure is reported once after three failed checks.

Set `notifyOnPrereleaseTags` or `notifyOnBackportOnlyReleases` in `Code.gs` to
change those choices.

## Files used by Google Apps Script

Only **`Code.gs` is required** in the Apps Script editor.

`appsscript.json` is an optional project manifest supplied for source-control
and `clasp` users. Apps Script creates and maintains a suitable hidden manifest
automatically, so an existing project's manifest normally should be left alone.

Do not copy these repository-only files into Apps Script:

- `README.md`
- `LICENSE`
- `package.json`
- `.gitignore`
- `test/logic.test.js`
- anything inside `.git/`

## New installation

1. Visit [script.google.com](https://script.google.com/) and select **New
   project**.
2. Give the project a recognizable name, such as **WordPress Core Release
   Monitor**.
3. Open the automatically created `Code.gs`, delete its sample contents, and
   paste in this repository's complete `Code.gs`.
4. Save the project.
5. Select `installMonitor` in the function menu at the top of the editor and
   click **Run**.
6. Review and approve the requested permissions. Google may show an
   unverified-app warning because this is your own unpublished script; use the
   advanced option to continue only after confirming that you created the
   project and pasted this source yourself.
7. Confirm that the installation email arrives.
8. Open **Triggers** in the left sidebar and confirm that there is one
   time-driven trigger for `checkWordPressReleases`.

By default, alerts go to the Google account that runs `installMonitor`. To use
a different recipient without putting an address in source control, add a
Script Property in **Project Settings**:

```text
Property: NOTIFICATION_EMAIL
Value: recipient@example.com
```

Run `installMonitor` again after changing the recipient or polling interval.

## Replacing an older version

The safest upgrade path is to update the existing Apps Script project. Its
saved release cursors are then available for migration and it retains the same
authorized Google account.

1. Open the existing monitor project at
   [script.google.com](https://script.google.com/).
2. Optionally save a private backup of the old `Code.gs`. Do not commit that
   backup if it contains a personal email address.
3. Open `Code.gs`, select all of its contents, and replace them with this
   repository's complete `Code.gs`.
4. Save the project.
5. Select and run `installMonitor`.
6. Approve any newly requested authorization.
7. Confirm that the installation email arrives.
8. Open **Triggers** and confirm that exactly one time-driven trigger remains,
   using `checkWordPressReleases` at the configured interval.

`installMonitor` establishes the new SVN-tag baseline before replacing the old
trigger. It also removes duplicate triggers and the legacy
`checkWordPressSecurity` trigger. If validation fails, the existing trigger is
left intact. The code retains a compatibility entry point in case the old
trigger runs between saving the file and completing installation.

## Polling interval

The default interval is 15 minutes. Apps Script supports 1, 5, 10, 15, or 30
minutes through `SETTINGS.checkIntervalMinutes`.

Five minutes is a reasonable faster option. One-minute polling creates 1,440
executions per day, consumes much more of the account's daily trigger-runtime
quota, and increases requests to the public WordPress services for little
practical gain.

Google documents current limits in the
[Apps Script quotas guide](https://developers.google.com/apps-script/guides/services/quotas).

## Manual checks and removal

- Run `checkWordPressReleases` for an immediate check.
- Run `uninstallMonitor` to remove this script's recurring triggers.

Uninstalling retains saved cursors so reinstalling does not generate historical
alerts.

## Reliability behavior

- A script-wide lock prevents overlapping scheduled and manual executions.
- Endpoint state is committed only after required email delivery succeeds.
- Saved release versions never move backward after a stale or partial response.
- Independent sources are checked separately, so one failed endpoint does not
  prevent the others from being examined.
- Transient network failures are retried once. Monitoring-error mail is held
  until the same failure persists for three consecutive scheduled checks, then
  deduplicated until the problem changes or clears.
- Existing installations using the original `checkWordPressSecurity` trigger
  continue to work until `installMonitor` replaces the legacy trigger.

## Development

The production script has no package dependencies. The test suite uses Node's
built-in test runner:

```shell
npm test
```

## Privacy and permissions

The script makes outbound requests only to the three sources listed above. It
stores release cursors and an optional notification address in Apps Script
Properties and uses `MailApp` only to send monitor notifications. It does not
read the contents of the recipient's mailbox.

## License

[MIT](LICENSE)

WordPress is a trademark of the WordPress Foundation. This project is an
independent utility and is not affiliated with or endorsed by the WordPress
Foundation or the WordPress project.
