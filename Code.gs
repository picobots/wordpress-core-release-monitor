/**
 * WordPress Core Release Monitor
 *
 * Monitors three official WordPress sources:
 *
 * 1. Development SVN tags for a high-confidence sign that release preparation
 *    is underway. WordPress builds release packages from these tags.
 * 2. The release archive for confirmation that a stable package is available.
 * 3. The security RSS feed for the later official announcement and context.
 *
 * Run installMonitor() once to initialize saved state and install the trigger.
 * The recipient defaults to the Google account that installs the trigger. To
 * use another address without placing it in source control, add a Script
 * Property named NOTIFICATION_EMAIL in Project Settings.
 */

const SETTINGS = Object.freeze({
  /**
   * Apps Script supports 1, 5, 10, 15, or 30 minutes.
   *
   * Fifteen minutes is intentionally conservative. Five minutes is also a
   * reasonable choice for faster alerts. One-minute polling creates 1,440
   * executions per day, consumes substantially more trigger runtime, increases
   * the chance of overlapping slow requests, and places unnecessary load on
   * the public WordPress endpoints for little practical benefit.
   *
   * Rerun installMonitor() after changing this value so the trigger is rebuilt.
   */
  checkIntervalMinutes: 15,

  /**
   * When enabled, an official stable SVN tag can generate one early warning
   * before the corresponding package reaches the release archive.
   */
  notifyOnPrereleaseTags: true,

  /**
   * Older-branch backports are recorded but do not produce separate emails.
   * This prevents a coordinated release from generating a message for every
   * historical branch as WordPress publishes its packages incrementally.
   */
  notifyOnBackportOnlyReleases: false,

  /** Maximum number of security-feed identifiers retained for deduplication. */
  rememberedSecurityEntries: 100,

  /** Wait this long for another execution to finish before failing. */
  lockWaitMilliseconds: 30000,

  /**
   * Retry a failed HTTP request once before treating its source as unavailable.
   * This absorbs occasional Apps Script DNS/routing errors without generating
   * an alert or waiting for the next scheduled execution.
   */
  fetchAttempts: 2,
  fetchRetryDelayMilliseconds: 1000,

  /**
   * Do not email for a single failed check. At the 15-minute default, three
   * consecutive failures represent an outage lasting roughly 30 minutes from
   * the first observation. Successful checks reset the counter immediately.
   */
  errorAlertAfterConsecutiveFailures: 3
});

const SOURCES = Object.freeze({
  securityFeed:
    'https://wordpress.org/news/category/security/feed/',
  releaseArchive:
    'https://wordpress.org/download/releases/',
  developmentTags:
    'https://develop.svn.wordpress.org/tags/'
});

const STATE_KEYS = Object.freeze({
  notificationEmail: 'NOTIFICATION_EMAIL',
  securityEntryIds: 'seenSecurityEntryIds',
  legacySecurityEntry: 'latestSecurityEntry',
  releasesByBranch: 'latestWordPressByBranch',
  tagsByBranch: 'latestWordPressTagByBranch',
  monitorErrorState: 'monitorErrorState',
  legacyMonitorErrorSignature: 'lastMonitorErrorSignature'
});

const TRIGGER_HANDLER = 'checkWordPressReleases';
const LEGACY_TRIGGER_HANDLER = 'checkWordPressSecurity';
const VALID_INTERVALS = Object.freeze([1, 5, 10, 15, 30]);

/**
 * Initializes the monitor and installs exactly one recurring trigger.
 *
 * Existing releases, tags, and announcements become the baseline, so setup
 * does not send a large collection of historical alerts. Both source checks
 * and email configuration are validated before an existing trigger is removed.
 */
function installMonitor() {
  validateSettings_();

  const email = getNotificationEmail_();

  // Establish a complete baseline before replacing a working trigger.
  checkWordPressReleases_(true, email);

  const newTrigger = ScriptApp.newTrigger(TRIGGER_HANDLER)
    .timeBased()
    .everyMinutes(SETTINGS.checkIntervalMinutes)
    .create();

  /*
   * Remove duplicate current triggers and triggers created by the original
   * version of this script. Keep the trigger we just created.
   */
  ScriptApp.getProjectTriggers()
    .filter(trigger =>
      [TRIGGER_HANDLER, LEGACY_TRIGGER_HANDLER].includes(
        trigger.getHandlerFunction()
      ) && trigger.getUniqueId() !== newTrigger.getUniqueId()
    )
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  sendEmail_(
    email,
    '[WordPress release monitor] Installation successful',
    [
      'The WordPress Core Release Monitor is installed.',
      '',
      'It will check these official sources approximately every ' +
        SETTINGS.checkIntervalMinutes + ' minutes:',
      SOURCES.developmentTags,
      SOURCES.releaseArchive,
      SOURCES.securityFeed,
      '',
      'Stable releases are discovered automatically. Beta, release candidate,',
      'and nightly versions are ignored.',
      '',
      'Older-branch backports are tracked silently to avoid duplicate alerts.',
      'A release alert does not by itself confirm a security release.'
    ].join('\n')
  );
}

/**
 * Removes triggers installed by this monitor. Saved state is retained so a
 * later reinstall does not treat every existing release as new.
 */
function uninstallMonitor() {
  ScriptApp.getProjectTriggers()
    .filter(trigger =>
      [TRIGGER_HANDLER, LEGACY_TRIGGER_HANDLER].includes(
        trigger.getHandlerFunction()
      )
    )
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

/** Called by the recurring trigger and available for manual checks. */
function checkWordPressReleases() {
  validateSettings_();
  checkWordPressReleases_(false, getNotificationEmail_());
}

/**
 * Backward-compatible entry point for an existing trigger from the original
 * script. Running installMonitor() replaces that trigger with the new handler.
 */
function checkWordPressSecurity() {
  checkWordPressReleases();
}

/**
 * Coordinates fetching, notification creation, delivery, and state updates.
 *
 * Proposed state is held in memory until any required email is delivered.
 * This deliberately favors a possible duplicate after an unusual property
 * write failure over permanently losing an alert when email delivery fails.
 */
function checkWordPressReleases_(initializing, email) {
  const lock = LockService.getScriptLock();

  lock.waitLock(SETTINGS.lockWaitMilliseconds);

  try {
    const properties = PropertiesService.getScriptProperties();
    const currentState = properties.getProperties();
    const pendingState = {};
    const errors = [];

    const securityResult = runSourceCheck_(
      'WordPress security RSS check failed',
      () => checkSecurityFeed_(currentState, initializing),
      errors
    );
    const releaseResult = runSourceCheck_(
      'WordPress release archive check failed',
      () => checkReleaseArchive_(currentState, initializing),
      errors
    );
    const tagResult = SETTINGS.notifyOnPrereleaseTags
      ? runSourceCheck_(
          'WordPress development tag check failed',
          () => checkDevelopmentTags_(currentState, initializing),
          errors
        )
      : null;

    [securityResult, releaseResult, tagResult]
      .filter(Boolean)
      .forEach(result => Object.assign(pendingState, result.state));

    /* A failed installation must not save an incomplete baseline. */
    if (initializing && errors.length) {
      throw new Error(formatSourceErrors_(errors));
    }

    const notices = initializing
      ? []
      : buildNotices_(securityResult, releaseResult, tagResult);

    addMonitoringErrorNotice_(
      errors,
      currentState,
      pendingState,
      notices
    );

    if (!initializing && notices.length) {
      sendEmail_(
        email,
        '[WordPress release monitor] WordPress update notice',
        notices.join(
          '\n\n----------------------------------------\n\n'
        )
      );
    }

    /* Commit source cursors only after successful notification delivery. */
    if (Object.keys(pendingState).length) {
      properties.setProperties(pendingState, false);
    }

    if (!errors.length) {
      properties.deleteProperty(STATE_KEYS.monitorErrorState);
      properties.deleteProperty(
        STATE_KEYS.legacyMonitorErrorSignature
      );
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Executes one independent source check. A failed endpoint is reported without
 * preventing the other official sources from being examined.
 */
function runSourceCheck_(label, check, errors) {
  try {
    return check();
  } catch (error) {
    errors.push({
      label,
      detail: formatError_(error)
    });

    return null;
  }
}

/**
 * Chooses meaningful notices while avoiding branch-by-branch release mail.
 */
function buildNotices_(securityResult, releaseResult, tagResult) {
  const notices = securityResult
    ? securityResult.notices.slice()
    : [];
  const primaryRelease = releaseResult
    ? releaseResult.primaryRelease
    : null;
  const primaryTag = tagResult ? tagResult.primaryTag : null;

  if (primaryRelease) {
    notices.push(formatPrimaryReleaseNotice_(primaryRelease));
  } else if (
    primaryTag &&
    !isVersionAvailable_(primaryTag.version, releaseResult)
  ) {
    notices.push(formatPrereleaseTagNotice_(primaryTag));
  } else if (
    SETTINGS.notifyOnBackportOnlyReleases &&
    releaseResult &&
    releaseResult.backports.length
  ) {
    notices.push(
      formatBackportNotice_(releaseResult.backports)
    );
  }

  return notices;
}

/** Checks the official WordPress security announcement feed. */
function checkSecurityFeed_(currentState, initializing) {
  const response = fetchSuccessful_(
    SOURCES.securityFeed,
    'WordPress security feed'
  );
  const document = XmlService.parse(response.getContentText());
  const channel = document.getRootElement().getChild('channel');

  if (!channel) {
    throw new Error(
      'The security feed did not contain an RSS channel.'
    );
  }

  const items = channel.getChildren('item');

  if (!items.length) {
    throw new Error(
      'The WordPress security feed contained no entries.'
    );
  }

  const entries = items.map(item => ({
    id:
      item.getChildText('guid') ||
      item.getChildText('link') ||
      item.getChildText('title'),
    title:
      item.getChildText('title') ||
      'Untitled WordPress security announcement',
    link:
      item.getChildText('link') ||
      SOURCES.securityFeed,
    date:
      item.getChildText('pubDate') ||
      'Publication date unavailable'
  }));
  const seenIds = parseSecurityEntryIds_(currentState);
  const seenIdSet = new Set(seenIds);
  const unseenEntries = initializing || !seenIds.length
    ? []
    : entries.filter(entry => !seenIdSet.has(entry.id));
  const rememberedIds = unique_(
    entries.map(entry => entry.id).concat(seenIds)
  ).slice(0, SETTINGS.rememberedSecurityEntries);

  return {
    notices: unseenEntries.map(entry =>
      [
        'OFFICIAL WORDPRESS SECURITY ANNOUNCEMENT',
        '',
        entry.title,
        entry.date,
        entry.link
      ].join('\n')
    ),
    state: {
      [STATE_KEYS.securityEntryIds]:
        JSON.stringify(rememberedIds)
    }
  };
}

/**
 * Checks the package archive and identifies the current customer-facing branch.
 * Every branch remains in saved state, but older backports are silent by
 * default so an incrementally published release produces only one alert.
 */
function checkReleaseArchive_(currentState, initializing) {
  const response = fetchSuccessful_(
    SOURCES.releaseArchive,
    'WordPress release archive'
  );
  const observedByBranch = extractReleasePackages_(
    response.getContentText()
  );
  const previousByBranch = parseJsonObject_(
    currentState[STATE_KEYS.releasesByBranch],
    STATE_KEYS.releasesByBranch
  );
  const mergedByBranch = mergeVersionState_(
    previousByBranch,
    observedByBranch
  );
  const changes = initializing
    ? []
    : findVersionChanges_(previousByBranch, observedByBranch);
  const primaryBranch = getLatestBranch_(observedByBranch);
  const primaryRelease =
    changes.find(change => change.branch === primaryBranch) || null;
  const backports = changes.filter(
    change => change.branch !== primaryBranch
  );

  return {
    observedByBranch,
    primaryRelease,
    backports,
    state: {
      [STATE_KEYS.releasesByBranch]:
        JSON.stringify(mergedByBranch)
    }
  };
}

/**
 * Checks official development tags. A stable numeric tag is a formal release
 * checkpoint: WordPress subsequently builds and tests packages from that tag.
 * Ordinary commits, beta tags, release candidates, and nightlies are ignored.
 */
function checkDevelopmentTags_(currentState, initializing) {
  const response = fetchSuccessful_(
    SOURCES.developmentTags,
    'WordPress development tags'
  );
  const observedByBranch = extractDevelopmentTags_(
    response.getContentText()
  );
  const previousByBranch = parseJsonObject_(
    currentState[STATE_KEYS.tagsByBranch],
    STATE_KEYS.tagsByBranch
  );
  const mergedByBranch = mergeVersionState_(
    previousByBranch,
    observedByBranch
  );
  const changes = initializing
    ? []
    : findVersionChanges_(previousByBranch, observedByBranch);
  const primaryBranch = getLatestBranch_(observedByBranch);
  const primaryTag =
    changes.find(change => change.branch === primaryBranch) || null;

  return {
    primaryTag,
    state: {
      [STATE_KEYS.tagsByBranch]:
        JSON.stringify(mergedByBranch)
    }
  };
}

/** Extracts stable package filenames such as wordpress-7.1.5.zip. */
function extractReleasePackages_(html) {
  const matches = html.matchAll(
    /wordpress-(\d+\.\d+(?:\.\d+)?)\.zip/gi
  );

  return buildLatestByBranch_(
    [...matches].map(match => match[1]),
    'release archive'
  );
}

/** Extracts stable numeric directories such as href="7.1.5/". */
function extractDevelopmentTags_(html) {
  const matches = html.matchAll(
    /href=["'](\d+\.\d+(?:\.\d+)?)\/["']/gi
  );

  return buildLatestByBranch_(
    [...matches].map(match => match[1]),
    'development tag list'
  );
}

/** Builds a compact newest-version record for each major/minor branch. */
function buildLatestByBranch_(versions, sourceName) {
  const uniqueVersions = unique_(versions);

  if (!uniqueVersions.length) {
    throw new Error(
      'No stable WordPress versions were found in the ' +
        sourceName + '.'
    );
  }

  const latestByBranch = {};

  uniqueVersions.forEach(version => {
    const branch = version.split('.').slice(0, 2).join('.');

    if (
      !latestByBranch[branch] ||
      compareVersions_(version, latestByBranch[branch]) > 0
    ) {
      latestByBranch[branch] = version;
    }
  });

  return latestByBranch;
}

/**
 * Never moves a saved branch backward or drops it because one response was
 * stale or incomplete. This prevents false repeat alerts when caches differ.
 */
function mergeVersionState_(previous, observed) {
  const merged = Object.assign({}, previous);

  Object.keys(observed).forEach(branch => {
    if (
      !merged[branch] ||
      compareVersions_(observed[branch], merged[branch]) > 0
    ) {
      merged[branch] = observed[branch];
    }
  });

  return merged;
}

function findVersionChanges_(previous, observed) {
  if (!Object.keys(previous).length) {
    return [];
  }

  return Object.keys(observed)
    .filter(branch =>
      !previous[branch] ||
      compareVersions_(observed[branch], previous[branch]) > 0
    )
    .map(branch => ({
      branch,
      previous: previous[branch] || null,
      version: observed[branch]
    }))
    .sort((left, right) =>
      compareVersions_(right.version, left.version)
    );
}

function getLatestBranch_(versionsByBranch) {
  return Object.keys(versionsByBranch).sort((left, right) =>
    compareVersions_(right, left)
  )[0];
}

function isVersionAvailable_(version, releaseResult) {
  if (!releaseResult) {
    return false;
  }

  const branch = version.split('.').slice(0, 2).join('.');
  const available = releaseResult.observedByBranch[branch];

  return available && compareVersions_(available, version) >= 0;
}

function formatPrimaryReleaseNotice_(release) {
  return [
    'NEW WORDPRESS CORE RELEASE AVAILABLE',
    '',
    release.previous
      ? release.previous + ' → ' + release.version
      : release.version + ' (new stable branch)',
    '',
    'Older branches may receive coordinated backports. They are tracked',
    'silently to avoid a separate email for every historical branch.',
    '',
    'A package appearing in the archive does not by itself confirm that the',
    'release contains a security fix:',
    SOURCES.releaseArchive
  ].join('\n');
}

function formatPrereleaseTagNotice_(tag) {
  return [
    'WORDPRESS CORE RELEASE PREPARATION DETECTED',
    '',
    'Official development tag: ' + tag.version,
    '',
    'WordPress creates this tag before building and testing release packages.',
    'The release appears imminent, but it is not yet available for installation.',
    '',
    SOURCES.developmentTags
  ].join('\n');
}

function formatBackportNotice_(backports) {
  return [
    'WORDPRESS CORE BACKPORT RELEASES DETECTED',
    '',
    ...backports.map(release =>
      release.branch + ' branch: ' +
      (release.previous || 'new branch') + ' → ' + release.version
    ),
    '',
    SOURCES.releaseArchive
  ].join('\n');
}

/**
 * Counts consecutive failures and reports a persistent outage only once.
 * A successful execution clears this state in checkWordPressReleases_().
 */
function addMonitoringErrorNotice_(
  errors,
  currentState,
  pendingState,
  notices
) {
  if (!errors.length) {
    return;
  }

  const errorMessage = formatSourceErrors_(errors);
  const signature = sha256_(errorMessage);
  const previous = parseMonitorErrorState_(currentState);
  const sameFailure = previous.signature === signature;
  const next = {
    signature,
    count: sameFailure ? previous.count + 1 : 1,
    notified: sameFailure ? previous.notified : false
  };

  if (
    next.count >= SETTINGS.errorAlertAfterConsecutiveFailures &&
    !next.notified
  ) {
    notices.push(
      'MONITORING ERROR\n' +
      errorMessage +
      '\n\nThis source has failed ' + next.count +
      ' consecutive checks. The monitor will keep trying automatically.'
    );

    next.notified = true;
  }

  pendingState[STATE_KEYS.monitorErrorState] = JSON.stringify(next);
}

/** Reads the current failure counter and tolerates state from older versions. */
function parseMonitorErrorState_(currentState) {
  const saved = currentState[STATE_KEYS.monitorErrorState];

  if (saved) {
    const parsed = JSON.parse(saved);

    if (
      parsed &&
      typeof parsed.signature === 'string' &&
      Number.isInteger(parsed.count) &&
      typeof parsed.notified === 'boolean'
    ) {
      return parsed;
    }

    throw new Error(
      STATE_KEYS.monitorErrorState +
      ' did not contain valid monitoring-error state.'
    );
  }

  const legacySignature =
    currentState[STATE_KEYS.legacyMonitorErrorSignature];

  return legacySignature
    ? { signature: legacySignature, count: 1, notified: true }
    : { signature: '', count: 0, notified: false };
}

function formatSourceErrors_(errors) {
  return errors
    .map(error => error.label + ':\n' + error.detail)
    .join('\n\n');
}

/**
 * Reads the optional private override, otherwise uses the installing account.
 * No recipient address needs to appear in this public source file.
 */
function getNotificationEmail_() {
  const configuredEmail = PropertiesService.getScriptProperties()
    .getProperty(STATE_KEYS.notificationEmail);
  const email = configuredEmail ||
    Session.getEffectiveUser().getEmail();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(
      'Unable to determine a notification address. Add a valid ' +
      STATE_KEYS.notificationEmail +
      ' value under Project Settings > Script Properties.'
    );
  }

  return email;
}

function validateSettings_() {
  if (!VALID_INTERVALS.includes(SETTINGS.checkIntervalMinutes)) {
    throw new Error(
      'checkIntervalMinutes must be one of: ' +
      VALID_INTERVALS.join(', ') + '.'
    );
  }

  if (
    !Number.isInteger(SETTINGS.rememberedSecurityEntries) ||
    SETTINGS.rememberedSecurityEntries < 1
  ) {
    throw new Error(
      'rememberedSecurityEntries must be a positive integer.'
    );
  }

  [
    'fetchAttempts',
    'errorAlertAfterConsecutiveFailures'
  ].forEach(settingName => {
    if (
      !Number.isInteger(SETTINGS[settingName]) ||
      SETTINGS[settingName] < 1
    ) {
      throw new Error(settingName + ' must be a positive integer.');
    }
  });
}

function fetchSuccessful_(url, sourceName) {
  let lastError;

  for (let attempt = 1; attempt <= SETTINGS.fetchAttempts; attempt++) {
    let response;

    try {
      response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true
      });
    } catch (error) {
      lastError = error;
    }

    if (response) {
      const status = response.getResponseCode();

      if (status === 200) {
        return response;
      }

      lastError = new Error(
        sourceName + ' returned HTTP status ' + status + '.'
      );

      /* Retry rate limits and server failures, but not permanent 4xx errors. */
      if (status !== 429 && status < 500) {
        throw lastError;
      }
    }

    if (attempt < SETTINGS.fetchAttempts) {
      Utilities.sleep(SETTINGS.fetchRetryDelayMilliseconds);
    }
  }

  throw new Error(
    sourceName + ' request failed after ' +
    SETTINGS.fetchAttempts + ' attempts:\n' +
    formatError_(lastError)
  );
}

function sendEmail_(recipient, subject, body) {
  if (MailApp.getRemainingDailyQuota() < 1) {
    throw new Error(
      'The Apps Script email recipient quota is exhausted.'
    );
  }

  MailApp.sendEmail(recipient, subject, body);
}

/** Migrates the original single RSS cursor to a bounded seen-ID collection. */
function parseSecurityEntryIds_(currentState) {
  const saved = currentState[STATE_KEYS.securityEntryIds];

  if (saved) {
    const parsed = JSON.parse(saved);

    if (!Array.isArray(parsed)) {
      throw new Error(
        STATE_KEYS.securityEntryIds + ' must contain a JSON array.'
      );
    }

    return parsed.filter(value => typeof value === 'string');
  }

  return currentState[STATE_KEYS.legacySecurityEntry]
    ? [currentState[STATE_KEYS.legacySecurityEntry]]
    : [];
}

function parseJsonObject_(saved, propertyName) {
  if (!saved) {
    return {};
  }

  const parsed = JSON.parse(saved);

  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== 'object'
  ) {
    throw new Error(
      propertyName + ' must contain a JSON object.'
    );
  }

  return parsed;
}

/** Compares numeric WordPress versions such as 6.9.10 and 6.9.9. */
function compareVersions_(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index++) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;

    if (leftPart > rightPart) {
      return 1;
    }

    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

function unique_(values) {
  return [...new Set(values)];
}

function sha256_(value) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  );

  return digest
    .map(byte => {
      const unsignedByte = byte < 0 ? byte + 256 : byte;

      return unsignedByte.toString(16).padStart(2, '0');
    })
    .join('');
}

function formatError_(error) {
  if (error && error.stack) {
    return error.stack;
  }

  if (error && error.message) {
    return error.message;
  }

  return String(error);
}
