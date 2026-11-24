'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'Code.gs'),
  'utf8'
);

function createRuntime(overrides = {}) {
  const state = overrides.initialState || {};
  const writes = [];
  const deletions = [];
  const emails = [];
  const properties = {
    getProperties: () => ({ ...state }),
    getProperty: key => state[key] || null,
    setProperties: values => {
      writes.push({ ...values });
      Object.assign(state, values);
    },
    deleteProperty: key => {
      deletions.push(key);
      delete state[key];
    }
  };
  const context = {
    PropertiesService: {
      getScriptProperties: () => properties
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {},
        releaseLock: () => {}
      })
    },
    MailApp: {
      getRemainingDailyQuota: () => 100,
      sendEmail: (...args) => {
        if (overrides.mailError) {
          throw overrides.mailError;
        }

        emails.push(args);
      }
    },
    Session: {
      getEffectiveUser: () => ({
        getEmail: () => 'owner@example.com'
      })
    },
    UrlFetchApp: overrides.urlFetchApp,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: () => [0],
      sleep: () => {}
    }
  };

  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    deletions,
    emails,
    evaluate: expression => vm.runInContext(expression, context),
    state,
    writes
  };
}

test('compares multi-digit patch versions numerically', () => {
  const runtime = createRuntime();

  assert.equal(
    runtime.evaluate("compareVersions_('6.9.10', '6.9.9')"),
    1
  );
});

test('extracts stable packages and excludes prereleases', () => {
  const runtime = createRuntime();
  const html = [
    '<a href="wordpress-7.1.4.zip">7.1.4</a>',
    '<a href="wordpress-7.1.5.zip">7.1.5</a>',
    '<a href="wordpress-7.2-RC1.zip">7.2 RC1</a>',
    '<a href="wordpress-6.9.12.zip">6.9.12</a>'
  ].join('');
  const result = JSON.parse(runtime.evaluate(
    `JSON.stringify(extractReleasePackages_(${JSON.stringify(html)}))`
  ));

  assert.deepEqual(result, {
    '6.9': '6.9.12',
    '7.1': '7.1.5'
  });
});

test('extracts stable SVN tags and excludes release candidates', () => {
  const runtime = createRuntime();
  const html = [
    '<a href="7.1.5/">7.1.5</a>',
    '<a href="7.2-RC1/">7.2 RC1</a>',
    '<a href="7.0.9/">7.0.9</a>'
  ].join('');
  const result = JSON.parse(runtime.evaluate(
    `JSON.stringify(extractDevelopmentTags_(${JSON.stringify(html)}))`
  ));

  assert.deepEqual(result, {
    '7.0': '7.0.9',
    '7.1': '7.1.5'
  });
});

test('does not regress or discard state after a stale response', () => {
  const runtime = createRuntime();
  const result = JSON.parse(runtime.evaluate(`JSON.stringify(
    mergeVersionState_(
      {'7.1':'7.1.5','7.0':'7.0.9'},
      {'7.1':'7.1.4'}
    )
  )`));

  assert.deepEqual(result, {
    '7.0': '7.0.9',
    '7.1': '7.1.5'
  });
});

test('suppresses older-branch release notices by default', () => {
  const runtime = createRuntime();
  const notices = JSON.parse(runtime.evaluate(`JSON.stringify(
    buildNotices_(
      {notices: []},
      {
        observedByBranch: {'7.1':'7.1.5','7.0':'7.0.9'},
        primaryRelease: null,
        backports: [
          {branch:'7.0',previous:'7.0.8',version:'7.0.9'}
        ]
      },
      null
    )
  )`));

  assert.deepEqual(notices, []);
});

test('does not advance cursors when notification delivery fails', () => {
  const runtime = createRuntime({
    mailError: new Error('mail failed')
  });

  runtime.evaluate(`
    checkSecurityFeed_ = () => ({notices: [], state: {security: 'new'}});
    checkReleaseArchive_ = () => ({
      observedByBranch: {'7.1':'7.1.5'},
      primaryRelease: {
        branch: '7.1',
        previous: '7.1.4',
        version: '7.1.5'
      },
      backports: [],
      state: {releases: 'new'}
    });
    checkDevelopmentTags_ = () => ({
      primaryTag: null,
      state: {tags: 'new'}
    });
  `);

  assert.throws(
    () => runtime.evaluate(
      "checkWordPressReleases_(false, 'person@example.com')"
    ),
    /mail failed/
  );
  assert.equal(runtime.writes.length, 0);
});

test('commits cursors after successful notification delivery', () => {
  const runtime = createRuntime();

  runtime.evaluate(`
    checkSecurityFeed_ = () => ({notices: [], state: {security: 'new'}});
    checkReleaseArchive_ = () => ({
      observedByBranch: {'7.1':'7.1.5'},
      primaryRelease: {
        branch: '7.1',
        previous: '7.1.4',
        version: '7.1.5'
      },
      backports: [],
      state: {releases: 'new'}
    });
    checkDevelopmentTags_ = () => ({
      primaryTag: null,
      state: {tags: 'new'}
    });
  `);
  runtime.evaluate(
    "checkWordPressReleases_(false, 'person@example.com')"
  );

  assert.equal(runtime.emails.length, 1);
  assert.deepEqual(runtime.writes, [{
    releases: 'new',
    security: 'new',
    tags: 'new'
  }]);
});

test('waits for three consecutive failures before sending one error notice', () => {
  const runtime = createRuntime();

  runtime.evaluate(`
    checkSecurityFeed_ = () => { throw new Error('Address unavailable'); };
    checkReleaseArchive_ = () => ({
      observedByBranch: {'7.1':'7.1.5'},
      primaryRelease: null,
      backports: [],
      state: {releases: 'current'}
    });
    checkDevelopmentTags_ = () => ({
      primaryTag: null,
      state: {tags: 'current'}
    });
  `);

  runtime.evaluate(
    "checkWordPressReleases_(false, 'person@example.com')"
  );
  runtime.evaluate(
    "checkWordPressReleases_(false, 'person@example.com')"
  );
  assert.equal(runtime.emails.length, 0);

  runtime.evaluate(
    "checkWordPressReleases_(false, 'person@example.com')"
  );
  assert.equal(runtime.emails.length, 1);

  runtime.evaluate(
    "checkWordPressReleases_(false, 'person@example.com')"
  );
  assert.equal(runtime.emails.length, 1);
});

test('retries a transient URL Fetch failure once', () => {
  let attempts = 0;
  const response = {
    getResponseCode: () => 200
  };
  const runtime = createRuntime({
    urlFetchApp: {
      fetch: () => {
        attempts++;

        if (attempts === 1) {
          throw new Error('Address unavailable');
        }

        return response;
      }
    }
  });

  assert.equal(
    runtime.evaluate(
      "fetchSuccessful_('https://example.com', 'Test source')" +
      '.getResponseCode()'
    ),
    200
  );
  assert.equal(attempts, 2);
});
